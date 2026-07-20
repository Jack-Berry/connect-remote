/**
 * The finder's position watch, wrapped in the observability the Genesis 1.3.0
 * hardware walk proved it needs.
 *
 * That walk showed one fix at entry and then a frozen screen, and there was no
 * way to tell from the outside which link had died: the platform delivering no
 * fixes, the accuracy filter silently discarding them, or the render side not
 * repainting. This wrapper makes the first two observable (every raw callback
 * and every rejection is counted) and adds the one recovery that is safe to
 * apply blindly: if the watch produces neither a fix nor an error for long
 * enough, it is silently dead — replace it. A suspended-and-resumed WebView
 * (phone screen lock) is the expected way to hit that.
 *
 * The isUsableFix gate lives here now, not in main.ts, precisely so a
 * rejection is a counted event rather than an invisible `return`.
 */

import type { FinderProblem, LatLon } from "./finder";
import { isUsableFix } from "./finder";
import {
  type PositionSource,
  type PositionWatch,
  type WatchHandlers,
  startPositionWatch,
} from "./geo";

/**
 * No fix AND no error for this long ⇒ the watch has died silently ⇒ start a
 * fresh one. Deliberately longer than the 30s position timeout in geo.ts: a
 * genuine no-signal spell must surface as the platform's TIMEOUT error — and
 * the "No GPS signal" screen — before the watchdog ever touches the watch.
 * Errors count as life, so a watch that is alive-but-failing is left alone.
 */
export const STALL_RESTART_MS = 45_000;

export interface FinderWatchTelemetry {
  /** Callbacks the platform actually delivered, before any filtering. */
  rawFixes: number;
  /** Fixes that passed isUsableFix and reached the finder. */
  usableFixes: number;
  /** Accuracy of the last fix the filter rejected — the number that says
   *  whether the threshold is wrong for real hardware. */
  lastRejectedAccuracy: number | null;
  problems: number;
  lastProblem: FinderProblem | null;
  /**
   * Wall-clock arrival of the last raw fix (0 = never). Arrival time, not
   * fix.at: a platform with a broken timestamp must not poison the stall
   * detection that exists to catch platform breakage.
   */
  lastFixAt: number;
  /** Last fix OR problem — any proof the watch is alive. */
  lastSignalAt: number;
  /** Underlying watches replaced by the stall watchdog. */
  restarts: number;
  /** Fresh watches forced by the phone screen coming back (main.ts). */
  resumes: number;
  /** Which source is feeding fixes (bridge/webkit/fake); null before the
   *  first watch reports in. Changes if a bridge watch falls back. */
  source: PositionSource | null;
  startedAt: number;
}

/** One telemetry object per finder session, shared across every watch the
 *  session creates (watchdog restarts, screen-wake restarts) so the counters
 *  tell the story of the whole walk, not the latest incarnation. */
export function createFinderTelemetry(now: number): FinderWatchTelemetry {
  return {
    rawFixes: 0,
    usableFixes: 0,
    lastRejectedAccuracy: null,
    problems: 0,
    lastProblem: null,
    lastFixAt: 0,
    lastSignalAt: 0,
    restarts: 0,
    resumes: 0,
    source: null,
    startedAt: now,
  };
}

export interface FinderWatch {
  /**
   * Call ~1 Hz (the finder tick). Replaces the underlying watch when it has
   * been completely silent for STALL_RESTART_MS — the self-heal for a watch
   * that a WebView suspension killed without an error.
   */
  poke(now: number): void;
  /** Idempotent, same contract as PositionWatch.stop. */
  stop(reason: string): void;
}

export function createFinderWatch(
  handlers: WatchHandlers,
  car: LatLon | null,
  telemetry: FinderWatchTelemetry,
  start: typeof startPositionWatch = startPositionWatch,
  now: () => number = Date.now,
): FinderWatch {
  let stopped = false;

  const wrapped: WatchHandlers = {
    onFix(fix) {
      const at = now();
      telemetry.rawFixes++;
      telemetry.lastFixAt = at;
      telemetry.lastSignalAt = at;
      if (!isUsableFix(fix)) {
        telemetry.lastRejectedAccuracy = fix.accuracy;
        return;
      }
      telemetry.usableFixes++;
      handlers.onFix(fix);
    },
    onProblem(problem) {
      telemetry.problems++;
      telemetry.lastProblem = problem;
      telemetry.lastSignalAt = now();
      handlers.onProblem(problem);
    },
    onSource(source) {
      telemetry.source = source;
      handlers.onSource?.(source);
    },
  };

  let watchStartedAt = now();
  let inner: PositionWatch = start(wrapped, car);

  return {
    poke(at) {
      if (stopped) return;
      const lastLife = Math.max(telemetry.lastSignalAt, watchStartedAt);
      if (at - lastLife <= STALL_RESTART_MS) return;
      telemetry.restarts++;
      inner.stop("stall watchdog");
      watchStartedAt = at;
      inner = start(wrapped, car);
      console.log(
        `finder: watch silent for ${Math.round((at - lastLife) / 1000)}s — replaced (restart #${telemetry.restarts})`,
      );
    },
    stop(reason) {
      if (stopped) return;
      stopped = true;
      inner.stop(reason);
    },
  };
}
