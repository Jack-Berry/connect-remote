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
