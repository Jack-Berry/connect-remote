/**
 * Keepalive WebSocket — the suspension-defeating spike (Round 3).
 *
 * Established on hardware: an app holding a live WebSocket (AbleShow) keeps
 * JS timers running with the phone locked; this app holds nothing and the
 * 1.3.1 walk proved its WebView suspends on lock, killing the GPS watch.
 * This module opens a do-nothing socket to the proxy for exactly as long as
 * the finder is open, to test whether a live socket transfers that keep-alive
 * behaviour. It carries no data — the server sends a heartbeat, we ignore it.
 *
 * Same leak discipline as the GPS watch: every open and close logs a line,
 * every exit path closes it, stop() is idempotent. A socket left open in a
 * pocket is a battery complaint with extra steps.
 */

/** Reconnect backoff. Resets on a successful open. The last value repeats:
 *  while the finder is open we never give up — whether the socket can stay up
 *  IS the experiment, so every failure is data, not a reason to stop. */
const RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

export interface SocketTelemetry {
  state: "connecting" | "open" | "closed" | "stopped";
  /** Successful opens (first + after reconnects). */
  opens: number;
  /** Reconnect attempts scheduled after a drop. */
  reconnects: number;
  lastCloseCode: number | null;
}

export function createSocketTelemetry(): SocketTelemetry {
  return { state: "connecting", opens: 0, reconnects: 0, lastCloseCode: null };
}

export interface KeepaliveSocket {
  telemetry: SocketTelemetry;
  /** Idempotent; `reason` is logged — the audit trail for "did it close?" */
  stop(reason: string): void;
}

/** The subset of WebSocket this module touches — injectable for tests. */
export interface SocketLike {
  onopen: (() => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export function openKeepaliveSocket(
  url: string,
  telemetry: SocketTelemetry = createSocketTelemetry(),
  makeSocket: (url: string) => SocketLike = (u) =>
    new WebSocket(u) as unknown as SocketLike,
): KeepaliveSocket {
  let stopped = false;
  let socket: SocketLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function connect() {
    telemetry.state = "connecting";
    let s: SocketLike;
    try {
      s = makeSocket(url);
    } catch (err) {
      // Constructor threw (bad URL, blocked scheme) — treat as a drop so the
      // backoff still applies and the failure is visible in telemetry.
      console.log(`finder: keepalive socket create failed: ${err}`);
      onDrop(null);
      return;
    }
    socket = s;
    s.onopen = () => {
      if (stopped) return;
      attempt = 0;
      telemetry.state = "open";
      telemetry.opens++;
      console.log("finder: keepalive socket open");
    };
    s.onclose = (ev) => {
      if (socket !== s) return; // superseded
      onDrop(typeof ev?.code === "number" ? ev.code : null);
    };
    // onerror is always followed by onclose; logging both would double-count.
    s.onerror = () => {};
  }

  function onDrop(code: number | null) {
    if (stopped) return;
    telemetry.state = "closed";
    telemetry.lastCloseCode = code;
    telemetry.reconnects++;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt++;
    console.log(
      `finder: keepalive socket dropped (code ${code ?? "?"}), retry in ${delay / 1000}s`,
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    telemetry,
    stop(reason) {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (socket) {
        // Detach first: the close event from our own close() must not be
        // counted as a drop.
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          /* already dead — closing was the point */
        }
      }
      telemetry.state = "stopped";
      console.log(`finder: keepalive socket stopped (${reason})`);
    },
  };
}
