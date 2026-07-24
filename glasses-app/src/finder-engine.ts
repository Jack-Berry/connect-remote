/**
 * The car finder's loop — one heartbeat, any number of renderers.
 *
 * Everything that used to be loose module state in main.ts (the GPS watch and
 * its lifecycle, the CourseTracker, the arrival streak, the telemetry, the
 * 1 Hz tick, the stall watchdog, the screen-wake restart) lives here now, so
 * BOTH surfaces — the glasses display and the phone radar — can render from the
 * same state at the same time without a second GPS watch or a mode fight. Each
 * surface is a FinderRenderer that attach()es; the loop runs while at least one
 * is attached and is provably torn down when the last one leaves.
 *
 * The engine touches no bridge and no DOM: every side effect (car position,
 * status metadata, the position source, the granted-once flag, the permission
 * probe, the clock) is injected, which is also what makes the loop unit-testable
 * for the first time — the orchestration was pure I/O glue before.
 *
 * Design rules carried verbatim from the battle-tested main.ts version, each
 * earned on a hardware walk:
 *   · one teardown path (stop) that every exit routes through, and it logs;
 *   · a re-entrancy latch, because a source that delivers its first fix
 *     synchronously (the DEV fake walker) would recurse through the late-car
 *     auto-start otherwise;
 *   · the tick pokes a stall watchdog so a watch a suspended WebView killed
 *     without an error gets replaced;
 *   · screen-wake REPLACES the watch (a suspended one may never deliver again),
 *     it does not merely resume it;
 *   · arrival is terminal and stops the watch where it happens — the job is
 *     done; nothing else has a timeout.
 */

import {
  type ArrivalProgress,
  CourseTracker,
  type Fix,
  type FinderProblem,
  type FinderView,
  type LatLon,
  bearingDeg,
  distanceMetres,
  finderView,
  formatParkedAge,
} from "./finder";
import {
  type FinderWatch,
  type FinderWatchTelemetry,
  createFinderTelemetry,
  createFinderWatch,
} from "./finder-watch";
import type { PositionWatch, WatchHandlers } from "./geo";
import {
  type PermissionProbe,
  isAwaitingPermission,
} from "./location-permission";

/** The honest instruction shown briefly on entry and after every screen-wake:
 *  no JS-side source survives a locked phone (three hardware rounds of proof),
 *  so the one thing the user can do is keep it unlocked. Exported so both
 *  renderers show the same words. */
export const KEEP_UNLOCKED_NOTE = "Keep your phone unlocked while finding your car";

/** How long that note borrows the detail line before the loop repaints past it. */
export const FINDER_NOTE_MS = 6000;

/** Re-render cadence: slow enough to be free, fast enough that the course
 *  expiring (user stopped) flips back to cardinal text promptly, and that a car
 *  position arriving on a later status poll is picked up within a second. */
export const FINDER_TICK_MS = 1000;

/**
 * Everything a renderer is handed each frame: the view model finder.ts already
 * produces, plus the raw geometry the phone radar needs (the glasses only need
 * the view; the radar draws dots and rings, so it gets bearing/distance/course
 * and computes its own layout). One object, computed once per tick, shared.
 */
export interface FinderFrame {
  view: FinderView;
  fix: Fix | null;
  car: LatLon | null;
  /** Travel course, degrees CW from N, or null when stationary/unknown — the
   *  same source the glasses arrow is quantised from. */
  course: number | null;
  /** Absolute bearing to the car, degrees CW from N; null without both ends. */
  bearingToCar: number | null;
  /** Great-circle metres to the car; null without both ends. */
  distanceM: number | null;
  /** Car position is old enough to earn a staleness line / dim ring. */
  stale: boolean;
  /** The keep-unlocked note is currently borrowing the detail line. */
  noteActive: boolean;
  /** The active watch problem (denied/unavailable), so a renderer can give each
   *  its own recovery copy. Null for the no-car case (that's derived from the
   *  absent car in the view, not a watch problem) and every non-problem state. */
  problem: FinderProblem | null;
  telemetry: FinderWatchTelemetry | null;
}

export interface FinderRenderer {
  /** Paint this frame. Called on entry (attach pushes the current frame), on
   *  every fix and problem, and on every tick. Must tolerate being called
   *  repeatedly with an unchanged frame — the renderer does its own diffing. */
  render(frame: FinderFrame): void | Promise<void>;
}

export interface FinderEngineDeps {
  /** Car position from the latest /status, or null if it hasn't reported one. */
  getCar(): LatLon | null;
  /** Account range unit + parked-time, straight from the latest /status. */
  getMeta(): { unit: string | null; parkedAt: string | null };
  /** The raw position source — startPositionWatch bound with (or without) the
   *  host bridge. Kept injected so geo.ts and the bridge stay out of here. */
  startWatch(handlers: WatchHandlers, car: LatLon | null): PositionWatch;
  /** Persisted "location granted at least once" marker (bridge KV). */
  loadGrantedOnce(): Promise<boolean>;
  saveGrantedOnce(): Promise<void>;
  /** Best-effort navigator.permissions probe; resolves "unknown" when absent. */
  probePermission(): Promise<PermissionProbe>;
  now?(): number;
  /** Where a render-time maths bug is logged; defaults to console.error. */
  onError?(where: string, err: unknown): void;
}

/** A crash-safe view for when finderView itself throws — a maths bug must still
 *  leave a readable screen with a way out, never a blank (store-review reject). */
function safeView(): FinderView {
  return {
    mode: "problem",
    arrow: null,
    headline: "Finder unavailable",
    detail: "Something went wrong\nTap to go back",
    hint: "Tap: back · 2x tap: close app",
    octant: null,
    arrival: { streak: 0, lastFixAt: 0 },
  };
}

export class FinderEngine {
  private readonly deps: FinderEngineDeps;
  private readonly now: () => number;

  private renderers = new Set<FinderRenderer>();

  // ---- session state (all reset by startSession) -------------------------
  private course = new CourseTracker();
  private fix: Fix | null = null;
  private problem: FinderProblem | null = null;
  private octant: number | null = null;
  private arrivalProgress: ArrivalProgress | null = null;
  private telem: FinderWatchTelemetry | null = null;
  private noteUntil = 0;

  private watch: FinderWatch | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private watchStarted = false;
  /** Set once arrival fires: the watch and tick are stopped but renderers stay
   *  attached showing the frozen arrived frame (the glasses schedule their own
   *  return to the HUD; the phone waits for Done). No restart while terminal. */
  private terminal = false;

  // Permission bootstrap. Until the granted-once flag has loaded we don't yet
  // know whether this is a first run, so we withhold the awaiting guess (else a
  // since-granted phone flashes "Unlock your phone" for the read's duration).
  private grantedOnce = false;
  private grantedOnceLoaded = false;
  private permission: PermissionProbe = "unknown";

  private lastFrame: FinderFrame | null = null;

  // Re-entrancy latch: a source delivering its first fix synchronously fires
  // onFix → emit → the tick's late-car auto-start, before `watch` is assigned —
  // infinite recursion (found by the 1.3.3 simulator sweep; real GPS never
  // delivers synchronously, which is why no hardware walk ever hit it).
  private starting = false;

  constructor(deps: FinderEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Whether a session is live (a watch/tick could be running). */
  isRunning(): boolean {
    return this.renderers.size > 0;
  }

  /** Telemetry for the diagnostic report — survives session end so a failed
   *  walk can still be described. */
  telemetry(): FinderWatchTelemetry | null {
    return this.telem;
  }

  /** The last frame emitted, for a renderer that wants current state without
   *  waiting for the next tick. */
  frame(): FinderFrame | null {
    return this.lastFrame;
  }

  /**
   * Add a renderer. The first one starts the session (fresh watch + tick + a
   * new keep-unlocked note); every one — first or joining a running session —
   * is immediately handed the current frame so a late joiner never sees a blank.
   */
  attach(renderer: FinderRenderer): void {
    const first = this.renderers.size === 0;
    this.renderers.add(renderer);
    if (first) {
      this.startSession();
    } else {
      // Join the running (or terminal) session: push what's on screen now.
      void renderer.render(this.emitFrame());
    }
  }

  /** Remove a renderer. When the last one leaves, the watch is provably torn
   *  down (the whole point of the discipline — a leaked GPS session drains a
   *  pocketed phone long after the user walked away). */
  detach(renderer: FinderRenderer): void {
    if (!this.renderers.delete(renderer)) return;
    if (this.renderers.size === 0) this.stop("last renderer detached");
  }

  /** Recompute and repaint now — a fresh /status may carry a newer car
   *  position or unit, and this also picks up a car that arrived after entry
   *  (starting the watch that was withheld while there was nothing to bear
   *  towards). No-op when idle or terminal. */
  refresh(): void {
    if (!this.isRunning() || this.terminal) return;
    if (this.deps.getCar() && !this.watch) this.startWatch();
    this.emit();
  }

  /** Screen woke (phone unlocked, WebView resumed). A suspended watch may never
   *  deliver again, so replace it outright; the tick/watchdog are the belt to
   *  this brace. Re-shows the keep-unlocked note — it's true again, the finder
   *  just lost a lock's worth of updates. No-op while terminal or idle. */
  pokeVisible(): void {
    if (!this.isRunning() || this.terminal) return;
    if (this.telem) this.telem.resumes++;
    this.noteUntil = this.now() + FINDER_NOTE_MS;
    // The permission picture may have changed while backgrounded (the user may
    // have answered the prompt on the lock screen).
    void this.deps.probePermission().then((p) => {
      this.permission = p;
      this.emit();
    });
    console.log("finder: page visible again — replacing GPS watch");
    this.startWatch();
    this.emit();
  }

  // ---- session lifecycle -------------------------------------------------

  private startSession(): void {
    this.course.reset();
    this.fix = null;
    this.problem = null;
    this.octant = null;
    this.arrivalProgress = null;
    this.watchStarted = false;
    this.terminal = false;
    this.grantedOnce = false;
    this.grantedOnceLoaded = false;
    this.permission = "unknown";
    this.lastFrame = null;
    this.telem = createFinderTelemetry(this.now());
    this.noteUntil = this.now() + FINDER_NOTE_MS;

    // Permission bootstrap, both best-effort. Emitting on resolve lets the
    // awaiting/locating copy settle to the truth within tens of ms.
    void this.deps.loadGrantedOnce().then((g) => {
      this.grantedOnce = g;
      this.grantedOnceLoaded = true;
      this.emit();
    });
    void this.deps.probePermission().then((p) => {
      this.permission = p;
      this.emit();
    });

    // The tick runs regardless of whether a watch exists: it lets the course go
    // stale, picks up a car position that arrives on a later poll, and rides
    // the stall watchdog.
    this.tick = setInterval(() => {
      this.watch?.poke(this.now());
      // Car position turned up after entry ⇒ now it makes sense to ask for GPS.
      if (this.deps.getCar() && !this.watch && !this.terminal) this.startWatch();
      this.emit();
    }, FINDER_TICK_MS);

    this.startWatch();
    this.emit();
  }

  /** The one teardown path. Every exit — last detach, arrival cleanup on a full
   *  stop — routes through here; the watch logs its own stop line. */
  private stop(reason: string): void {
    this.stopWatchAndTick(reason);
    this.terminal = false;
  }

  private stopWatchAndTick(reason: string): void {
    if (this.watch) {
      this.watch.stop(reason);
      this.watch = null;
    }
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  private startWatch(): void {
    if (this.starting) return;
    this.starting = true;
    try {
      this.startWatchInner();
    } finally {
      this.starting = false;
    }
  }

  private startWatchInner(): void {
    // Replace any existing watch (screen-wake / restart), but keep the tick.
    if (this.watch) {
      this.watch.stop("restart");
      this.watch = null;
    }
    const car = this.deps.getCar();
    // No car position ⇒ nothing to bear towards, so don't prompt for GPS yet.
    // The tick above starts the watch the moment coordinates arrive.
    if (!car) return;
    this.telem ??= createFinderTelemetry(this.now());
    this.watchStarted = true;
    this.watch = createFinderWatch(
      {
        onFix: (fix) => {
          this.problem = null;
          this.fix = fix;
          this.course.push(fix);
          // First proof permission is granted — remember it, so a later run's
          // slow fix reads as "Locating…", never a false "unlock your phone".
          if (!this.grantedOnce) {
            this.grantedOnce = true;
            this.grantedOnceLoaded = true;
            void this.deps.saveGrantedOnce();
          }
          this.emit();
        },
        onProblem: (problem) => {
          this.problem = problem;
          this.emit();
        },
      },
      car,
      this.telem,
      this.deps.startWatch,
      this.now,
    );
  }

  // ---- frame production --------------------------------------------------

  private emitFrame(): FinderFrame {
    const now = this.now();
    const car = this.deps.getCar();
    const { unit, parkedAt } = this.deps.getMeta();
    const course = this.course.course(now);

    // Withhold the awaiting guess until we actually know whether this is a
    // first run — otherwise a granted phone flashes the walkthrough copy.
    const awaiting =
      this.grantedOnceLoaded &&
      isAwaitingPermission({
        hasFix: this.fix != null,
        problem: this.problem,
        grantedOnce: this.grantedOnce,
        permission: this.permission,
        watchStarted: this.watchStarted,
      });

    let view: FinderView;
    try {
      view = finderView({
        car,
        fix: this.fix,
        course,
        now,
        unit,
        parkedAt,
        prevOctant: this.octant,
        arrival: this.arrivalProgress,
        problem: this.problem,
        awaitingPermission: awaiting,
      });
      this.octant = view.octant;
      this.arrivalProgress = view.arrival;
    } catch (err) {
      (this.deps.onError ?? ((w, e) => console.error(w, e)))(
        "render/finder",
        err,
      );
      view = safeView();
    }

    const noteActive =
      view.mode !== "problem" &&
      view.mode !== "awaiting" &&
      now < this.noteUntil;
    const stale = formatParkedAge(parkedAt, now) != null;
    const both = this.fix != null && car != null;

    return {
      view,
      fix: this.fix,
      car,
      course,
      bearingToCar: both ? bearingDeg(this.fix as Fix, car as LatLon) : null,
      distanceM: both ? distanceMetres(this.fix as Fix, car as LatLon) : null,
      stale,
      noteActive,
      problem: this.problem,
      telemetry: this.telem,
    };
  }

  /** Compute the current frame, apply the terminal (arrival) transition, and
   *  push it to every attached renderer. */
  private emit(): void {
    const frame = this.emitFrame();
    this.lastFrame = frame;
    // Arrival ends the walk: the watch stops right here (not on the way out),
    // the tick stops too (nothing changes after), and the frame is frozen.
    // Renderers react to mode === "arrived" themselves (glasses hold→HUD,
    // phone Done).
    if (frame.view.mode === "arrived" && !this.terminal) {
      this.terminal = true;
      this.stopWatchAndTick("arrived");
    }
    for (const r of this.renderers) void r.render(frame);
  }
}

export function createFinderEngine(deps: FinderEngineDeps): FinderEngine {
  return new FinderEngine(deps);
}
