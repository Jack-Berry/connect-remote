"""Hosted stateless proxy for Genesis / Kia / Hyundai Connected Services.

Credentials (username, password, PIN), region and brand arrive in every
request body from the client; the proxy holds no account configuration. The
only state is a short-TTL in-memory session cache (see session_cache.py) plus
per-account force-refresh throttles — both keyed by a one-way credential
hash, neither persisted.

Logging policy: method, path, status code, latency. Never request bodies,
headers, or query strings — bodies carry car-unlocking credentials.
"""

import json
import logging
import os
import time
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from hyundai_kia_connect_api.const import BRANDS, REGIONS
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from .providers.base import (
    AuthError,
    ClimateSettings,
    ProviderDataError,
    UpstreamError,
    VehicleStatus,
)
from .rate_limit import FailedAuthLimiter, ThrottleRegistry
from .redact import redact
from .session_cache import Session, SessionCache

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Session cache TTL — how long a live upstream login is reused. Short enough
# that a stolen-credential session dies quickly, long enough that a normal
# glasses session (poll + a couple of commands) logs in once.
SESSION_TTL_SECONDS = 600

# Per-account force-refresh throttle: protects the car's 12 V battery and the
# Connected Services daily command limits, independent of client IP.
REFRESH_MIN_INTERVAL_SECONDS = 900
REFRESH_DAILY_CAP = 20

# Per-client-IP request limits. The general limit covers polling; the
# expensive limit guards the two paths that always hit the upstream hard
# (/refresh wakes the car, /debug/fields dumps everything).
RATE_GENERAL = "30/minute"
RATE_EXPENSIVE = "5/minute"

# Failed-auth limiter: 5 upstream auth failures from one IP within 15 min
# blocks that IP's car endpoints for 15 min (see FailedAuthLimiter).
AUTH_FAIL_MAX = 5
AUTH_FAIL_WINDOW_SECONDS = 900.0
AUTH_FAIL_BLOCK_SECONDS = 900.0


def _build_provider(creds: "Credentials"):
    # Imported lazily so tests can run with a fake provider factory.
    from .providers.genesis import GenesisProvider

    return GenesisProvider(
        username=creds.username,
        password=creds.password,
        pin=creds.pin,
        region=creds.region,
        brand=creds.brand,
    )


def _client_ip(request: Request) -> str:
    """Rate-limit key. The app container is reachable only through Caddy on
    the internal Docker network, so X-Forwarded-For is trustworthy; without
    it every client would share Caddy's container IP and one bucket."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


limiter = Limiter(key_func=_client_ip, default_limits=[RATE_GENERAL])

app = FastAPI(title="connect-remote-proxy", docs_url=None, redoc_url=None)
app.state.limiter = limiter
app.state.cache = SessionCache(factory=_build_provider, ttl_seconds=SESSION_TTL_SECONDS)
app.state.refresh_throttles = ThrottleRegistry(
    REFRESH_MIN_INTERVAL_SECONDS, REFRESH_DAILY_CAP
)
app.state.failed_auth = FailedAuthLimiter(
    AUTH_FAIL_MAX, AUTH_FAIL_WINDOW_SECONDS, AUTH_FAIL_BLOCK_SECONDS
)
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Middleware runs outermost-last-added: CORS wraps the access log wraps the
# rate limiter, so 429s are both logged and CORS-tagged.
app.add_middleware(SlowAPIMiddleware)


@app.middleware("http")
async def access_log(request: Request, call_next):
    t0 = time.monotonic()
    response = await call_next(request)
    logger.info(
        "%s %s -> %d %.0fms",
        request.method,
        request.url.path,
        response.status_code,
        (time.monotonic() - t0) * 1000,
    )
    return response


# The glasses WebView loads from http://127.0.0.1:<random-port>, so every
# request is cross-origin; auth is credentials-in-body, not cookies, so a
# wildcard is safe.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class Credentials(BaseModel):
    # repr=False keeps values out of accidental str()/repr() of the model —
    # nothing logs these on purpose, this is belt and braces.
    username: str = Field(min_length=1, repr=False)
    password: str = Field(min_length=1, repr=False)
    pin: str = Field(default="", repr=False)
    region: int
    brand: int

    @field_validator("region")
    @classmethod
    def _known_region(cls, v: int) -> int:
        if v not in REGIONS:
            raise ValueError(f"unknown region {v}; known: {REGIONS}")
        return v

    @field_validator("brand")
    @classmethod
    def _known_brand(cls, v: int) -> int:
        if v not in BRANDS:
            raise ValueError(f"unknown brand {v}; known: {BRANDS}")
        return v


class CredentialedRequest(BaseModel):
    credentials: Credentials


class ClimateBody(CredentialedRequest):
    on: bool
    temp: float = Field(default=21.0, ge=14, le=30)
    defrost: bool = False
    heating: bool = False


class ChargeBody(CredentialedRequest):
    on: bool


class ChargeLimitsBody(CredentialedRequest):
    # Upstream accepts 50–100% in 10% steps; validate the range and let the
    # car reject odd steps rather than second-guessing per-model rules.
    ac: int = Field(ge=50, le=100)
    dc: int = Field(ge=50, le=100)


class CommandAccepted(BaseModel):
    sent: bool = True
    note: str = "Command sent. The car takes 30-90 s to apply it; re-poll /status after a delay."
    sent_at: datetime


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _session(request: Request, creds: Credentials) -> Session:
    """Choke point for every car endpoint (healthz doesn't pass through):
    an IP inside a failed-auth block is rejected here, before anything can
    reach the upstream."""
    blocked, retry_after = request.app.state.failed_auth.check(_client_ip(request))
    if blocked:
        raise HTTPException(
            status_code=429,
            detail="too many failed sign-ins from this network — "
            f"wait about {max(1, retry_after // 60)} min and try again",
            headers={"Retry-After": str(retry_after)},
        )
    return request.app.state.cache.get_or_create(creds)


def _auth_failed(request: Request, session: Session, exc: AuthError) -> HTTPException:
    """Evict the dead session so the next attempt does a clean login, count
    the failure against the client IP, and tell the client its credentials
    were rejected."""
    request.app.state.cache.evict(session.key)
    request.app.state.failed_auth.record_failure(_client_ip(request))
    return HTTPException(
        status_code=401,
        detail=f"Connected Services rejected the credentials: {exc}",
    )


def _auth_ok(request: Request) -> None:
    """An upstream call authenticated fine — forget the IP's failed sign-ins
    so a user who mistypes, then fixes it, never accumulates toward a block."""
    request.app.state.failed_auth.record_success(_client_ip(request))


def _parse_bug_response(exc: ProviderDataError) -> HTTPException:
    # 500, not 502: the glasses/phone apps map 502 to "service unreachable",
    # which sends users chasing credentials/network for what is our bug.
    logger.error("provider data parse failure (backend bug): %s", exc)
    return HTTPException(
        status_code=500,
        detail=f"backend could not parse vehicle data — backend bug, please report: {exc}",
    )


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict:
    """Unauthenticated liveness probe for Docker health checks and the app's
    Test connection button. Must not touch the upstream. Exposes the deployed
    commit (GIT_COMMIT baked in at image build) so a deploy can be confirmed
    live."""
    return {"ok": True, "commit": os.environ.get("GIT_COMMIT")}


@app.post("/status", response_model=VehicleStatus)
def get_status(body: CredentialedRequest, request: Request) -> VehicleStatus:
    session = _session(request, body.credentials)
    try:
        status = session.provider.get_cached_status()
        session.last_known = status
        _auth_ok(request)
        return status
    except AuthError as exc:
        raise _auth_failed(request, session, exc)
    except ProviderDataError as exc:
        # Upstream answered but we couldn't decode it — a backend bug, not an
        # outage. Surface it loudly instead of masking it with stale data;
        # the glasses app keeps showing last-known values client-side anyway.
        raise _parse_bug_response(exc)
    except UpstreamError as exc:
        # Degrade gracefully: serve last-known state marked stale, not a 500.
        if session.last_known is not None:
            logger.warning("upstream failed, serving stale status: %s", exc)
            return session.last_known.model_copy(update={"stale": True})
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}")


@app.post("/refresh", response_model=VehicleStatus)
@limiter.limit(RATE_EXPENSIVE)
def force_refresh(body: CredentialedRequest, request: Request) -> VehicleStatus:
    session = _session(request, body.credentials)
    throttle = request.app.state.refresh_throttles.get(session.key)
    allowed, retry_after = throttle.try_acquire()
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="force refresh throttled",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        status = session.provider.force_refresh()
        session.last_known = status
        _auth_ok(request)
        return status
    except AuthError as exc:
        raise _auth_failed(request, session, exc)
    except ProviderDataError as exc:
        raise _parse_bug_response(exc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}")


@app.post("/debug/fields", include_in_schema=False)
@limiter.limit(RATE_EXPENSIVE)
def debug_fields(body: CredentialedRequest, request: Request) -> Response:
    """Redacted dump of every field the car reports, for users to paste into
    a bug report — especially a parse failure, or a car whose fields we've
    never seen. No response_model on purpose: this must survive the data that
    VehicleStatus chokes on. Pretty-printed to read in a browser/bug report."""
    session = _session(request, body.credentials)
    try:
        raw = session.provider.get_raw_fields()
    except AuthError as exc:
        raise _auth_failed(request, session, exc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}")
    _auth_ok(request)
    content = json.dumps(redact(raw), indent=2, sort_keys=True, default=str)
    return Response(content=content, media_type="application/json")


def _send_command(request: Request, creds: Credentials, fn) -> CommandAccepted:
    session = _session(request, creds)
    try:
        fn(session.provider)
    except AuthError as exc:
        raise _auth_failed(request, session, exc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}")
    _auth_ok(request)
    return CommandAccepted(sent_at=_now())


@app.post("/climate", response_model=CommandAccepted)
def climate(body: ClimateBody, request: Request) -> CommandAccepted:
    return _send_command(
        request,
        body.credentials,
        lambda p: p.set_climate(
            ClimateSettings(
                on=body.on, temp=body.temp, defrost=body.defrost, heating=body.heating
            )
        ),
    )


@app.post("/charge", response_model=CommandAccepted)
def charge(body: ChargeBody, request: Request) -> CommandAccepted:
    return _send_command(
        request,
        body.credentials,
        lambda p: p.start_charge() if body.on else p.stop_charge(),
    )


@app.post("/charge-limits", response_model=CommandAccepted)
def charge_limits(body: ChargeLimitsBody, request: Request) -> CommandAccepted:
    return _send_command(
        request, body.credentials, lambda p: p.set_charge_limits(body.ac, body.dc)
    )


@app.post("/lock", response_model=CommandAccepted)
def lock(body: CredentialedRequest, request: Request) -> CommandAccepted:
    return _send_command(request, body.credentials, lambda p: p.lock())


@app.post("/unlock", response_model=CommandAccepted)
def unlock(body: CredentialedRequest, request: Request) -> CommandAccepted:
    return _send_command(request, body.credentials, lambda p: p.unlock())
