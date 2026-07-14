import threading
import time
from datetime import date


class RefreshThrottle:
    """Min-interval + daily-cap throttle for force refresh.

    In-memory: a backend restart resets the counters, which errs on the
    permissive side — acceptable for a single-user service. The point is to
    stop runaway polling from hitting Genesis daily limits and draining the
    car's 12 V battery.
    """

    def __init__(self, min_interval_seconds: int, daily_cap: int):
        self._min_interval = min_interval_seconds
        self._daily_cap = daily_cap
        self._lock = threading.Lock()
        self._last_refresh: float = 0.0
        self._count_day: date = date.today()
        self._count = 0

    def try_acquire(self) -> tuple[bool, int]:
        """Returns (allowed, retry_after_seconds)."""
        with self._lock:
            now = time.monotonic()
            today = date.today()
            if today != self._count_day:
                self._count_day = today
                self._count = 0

            elapsed = now - self._last_refresh
            if self._last_refresh and elapsed < self._min_interval:
                return False, int(self._min_interval - elapsed) + 1
            if self._count >= self._daily_cap:
                return False, 3600  # try again in an hour; cap resets at midnight

            self._last_refresh = now
            self._count += 1
            return True, 0


class ThrottleRegistry:
    """Per-account force-refresh throttles, keyed by the same one-way
    credential hash as the session cache.

    Deliberately separate from the session cache: sessions expire after
    minutes, but the throttle exists to stop runaway car wake-ups, so it must
    outlive them (the min interval alone is longer than the session TTL).
    Holds only timestamps/counters — never credentials. Entries idle past
    idle_expiry_seconds are pruned to bound memory.
    """

    def __init__(
        self,
        min_interval_seconds: int,
        daily_cap: int,
        idle_expiry_seconds: float = 86_400.0,
    ):
        self._min_interval = min_interval_seconds
        self._daily_cap = daily_cap
        self._idle_expiry = idle_expiry_seconds
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[RefreshThrottle, float]] = {}

    def get(self, key: str) -> RefreshThrottle:
        now = time.monotonic()
        with self._lock:
            for k in [
                k for k, (_, seen) in self._entries.items()
                if now - seen > self._idle_expiry
            ]:
                del self._entries[k]
            throttle, _ = self._entries.get(
                key, (RefreshThrottle(self._min_interval, self._daily_cap), 0.0)
            )
            self._entries[key] = (throttle, now)
            return throttle


class FailedAuthLimiter:
    """Per-IP upstream-auth-failure limiter.

    After max_failures upstream authentication failures from one IP within
    window_seconds, that IP's car-endpoint requests are rejected with 429 for
    block_seconds — protecting users' manufacturer accounts from credential
    spraying through us, and this proxy's IP reputation with the upstream.

    Lockout is survivable by design: the block is fixed at trip time and
    rejected requests do NOT extend it (no punishment loop); when it expires
    the failure record is wiped so stale failures can't re-trip it; and a
    successful auth clears the IP's record entirely. In-memory only.
    """

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: float = 900.0,
        block_seconds: float = 900.0,
    ):
        self._max = max_failures
        self._window = window_seconds
        self._block = block_seconds
        self._lock = threading.Lock()
        self._failures: dict[str, list[float]] = {}
        self._blocked_until: dict[str, float] = {}

    def check(self, ip: str) -> tuple[bool, int]:
        """Returns (blocked, retry_after_seconds)."""
        now = time.monotonic()
        with self._lock:
            until = self._blocked_until.get(ip)
            if until is not None:
                if now < until:
                    return True, int(until - now) + 1
                del self._blocked_until[ip]
                self._failures.pop(ip, None)
            return False, 0

    def record_failure(self, ip: str) -> None:
        now = time.monotonic()
        with self._lock:
            fails = [t for t in self._failures.get(ip, ()) if now - t < self._window]
            fails.append(now)
            if len(fails) >= self._max:
                self._blocked_until[ip] = now + self._block
                self._failures.pop(ip, None)
            else:
                self._failures[ip] = fails
            self._prune(now)

    def record_success(self, ip: str) -> None:
        with self._lock:
            self._failures.pop(ip, None)

    def _prune(self, now: float) -> None:
        # Bound memory: drop failure lists whose newest entry left the window,
        # and blocks that have expired.
        for ip in [
            ip for ip, f in self._failures.items() if now - f[-1] > self._window
        ]:
            del self._failures[ip]
        for ip in [ip for ip, u in self._blocked_until.items() if now >= u]:
            del self._blocked_until[ip]
