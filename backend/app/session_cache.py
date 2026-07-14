"""In-memory session cache — the proxy's one deliberate piece of state.

The proxy is stateless per request (credentials arrive in every body), but a
full Connected Services login takes seconds and the EU endpoints rate-limit
fresh logins, so live VehicleManager sessions are kept in memory for a short
TTL. The map key is a SHA-256 over the credential tuple: no plaintext
credentials are ever stored, persisted, or logged — losing an entry (restart,
expiry, eviction) only costs the next request a fresh login.
"""

import hashlib
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from .providers.base import VehicleStatus


def credentials_key(
    username: str, password: str, pin: str, region: int, brand: int
) -> str:
    # NUL separator keeps the concatenation unambiguous ("ab"+"c" vs "a"+"bc").
    material = "\x00".join((username, password, pin, str(region), str(brand)))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass
class Session:
    key: str
    # Implements both StatusProvider and CommandProvider (see providers.base).
    provider: Any
    last_used: float
    # Last successful status, served marked-stale when upstream is down.
    last_known: VehicleStatus | None = None


class SessionCache:
    """Plain dict + timestamps behind one lock.

    TTL counts from last use: an actively-polled session stays cached (the
    provider refreshes its own upstream token per call), an idle one is
    dropped. max_sessions caps memory against a client spraying distinct
    (fake) credentials — least-recently-used entries go first.
    """

    def __init__(
        self,
        factory: Callable[[Any], Any],
        ttl_seconds: float = 600.0,
        max_sessions: int = 200,
    ):
        self._factory = factory
        self._ttl = ttl_seconds
        self._max = max_sessions
        self._lock = threading.Lock()
        self._sessions: dict[str, Session] = {}

    def get_or_create(self, creds) -> Session:
        """creds needs username/password/pin/region/brand attributes."""
        key = credentials_key(
            creds.username, creds.password, creds.pin, creds.region, creds.brand
        )
        now = time.monotonic()
        with self._lock:
            self._evict_expired(now)
            session = self._sessions.get(key)
            if session is None:
                # Building a provider is cheap (no network until first use),
                # so holding the lock here is fine.
                session = Session(
                    key=key, provider=self._factory(creds), last_used=now
                )
                self._sessions[key] = session
                if len(self._sessions) > self._max:
                    oldest = min(
                        self._sessions, key=lambda k: self._sessions[k].last_used
                    )
                    del self._sessions[oldest]
            session.last_used = now
            return session

    def evict(self, key: str) -> None:
        with self._lock:
            self._sessions.pop(key, None)

    def _evict_expired(self, now: float) -> None:
        expired = [
            k for k, s in self._sessions.items() if now - s.last_used > self._ttl
        ]
        for k in expired:
            del self._sessions[k]
