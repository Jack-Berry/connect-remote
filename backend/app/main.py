"""Hosted stateless proxy for Genesis / Kia / Hyundai Connected Services.

Credentials (username, password, PIN), region and brand arrive in every
request body from the client; the proxy holds no account configuration. The
only state is a short-TTL in-memory session cache (see session_cache.py) plus
per-account force-refresh throttles — both keyed by a one-way credential
hash, neither persisted.

Logging policy: method, path, status code, latency. Never request bodies,
headers, or query strings — bodies carry car-unlocking credentials.
"""

import asyncio
import json
import logging
import os
import secrets
import time
from datetime import datetime, timezone

from fastapi import (
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
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
    ReenrollRequired,
    UpstreamError,
    VehicleStatus,
)
from . import shape_capture
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

# Kia-US enrollment: per-credential throttle to prevent OTP spam.
# 3 attempts per hour is generous for a human enrolling; an attacker trying
# to flood someone's email/SMS gets 3 codes then waits an hour.
ENROLL_MIN_INTERVAL_SECONDS = 120
ENROLL_HOURLY_CAP = 3


def _build_provider(creds: "Credentials"):
    # Imported lazily so tests can run with a fake provider factory.
    from .providers.genesis import GenesisProvider

    return GenesisProvider(
        username=creds.username,
        password=creds.password,
        pin=creds.pin,
        region=creds.region,
        brand=creds.brand,
        device_token=creds.device_token,
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
app.state.enroll_throttles = ThrottleRegistry(
    ENROLL_MIN_INTERVAL_SECONDS, ENROLL_HOURLY_CAP
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
    # Kia-US only: stored device token from OTP enrollment (device_id +
    # rmtoken). Sent per-request so the proxy stays stateless. Not included
    # in the session cache key — it's derived state, not account identity.
    device_token: dict | None = Field(default=None, repr=False)

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


def _reenroll_needed(request: Request, session: Session, exc: ReenrollRequired) -> HTTPException:
    """Kia-US: device trust missing or expired. Evict the session (so the
    next request with a fresh device_token builds a new provider) but do NOT
    count it as a failed auth — credentials are fine, only device trust is
    absent. 409, not 401."""
    request.app.state.cache.evict(session.key)
    return HTTPException(status_code=409, detail=str(exc))


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


# Keepalive WebSocket (glasses car-finder). The socket carries NO data in
# either direction — its only job is existing: iOS keeps a WKWebView's JS
# running under screen lock when the page holds a live socket, and the finder
# needs its GPS watch to survive exactly that. Hence: no auth (there is
# nothing to protect), a server heartbeat so intermediaries never see an idle
# stream, and a hard per-IP connection cap since slowapi's HTTP rate limiter
# does not see WebSocket handshakes.
WS_HEARTBEAT_SECONDS = 20.0
WS_MAX_CONNECTIONS_PER_IP = 4
_ws_connections: dict[str, int] = {}


def _ws_client_ip(ws: WebSocket) -> str:
    forwarded = ws.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return ws.client.host if ws.client else "unknown"


@app.websocket("/ws")
async def keepalive_ws(ws: WebSocket) -> None:
    ip = _ws_client_ip(ws)
    if _ws_connections.get(ip, 0) >= WS_MAX_CONNECTIONS_PER_IP:
        # 1013 "try again later" — a well-behaved client backs off.
        await ws.close(code=1013)
        return
    await ws.accept()
    _ws_connections[ip] = _ws_connections.get(ip, 0) + 1
    try:
        while True:
            # Listen (so a disconnect is noticed immediately, not at the next
            # heartbeat) and send the heartbeat on the listen timeout.
            try:
                message = await asyncio.wait_for(
                    ws.receive(), timeout=WS_HEARTBEAT_SECONDS
                )
            except asyncio.TimeoutError:
                await ws.send_text("ka")
                continue
            if message.get("type") == "websocket.disconnect":
                break
            # Any client payload is ignored — this socket carries nothing.
    except (WebSocketDisconnect, RuntimeError):
        # Disconnect surfaces as either, depending on who noticed first.
        pass
    finally:
        remaining = _ws_connections.get(ip, 1) - 1
        if remaining > 0:
            _ws_connections[ip] = remaining
        else:
            _ws_connections.pop(ip, None)


@app.post("/status", response_model=VehicleStatus)
def get_status(body: CredentialedRequest, request: Request) -> VehicleStatus:
    session = _session(request, body.credentials)
    try:
        status = session.provider.get_cached_status()
        session.last_known = status
        _auth_ok(request)
        return status
    except ReenrollRequired as exc:
        raise _reenroll_needed(request, session, exc)
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
    except ReenrollRequired as exc:
        raise _reenroll_needed(request, session, exc)
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
    except ReenrollRequired as exc:
        raise _reenroll_needed(request, session, exc)
    except AuthError as exc:
        raise _auth_failed(request, session, exc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}")
    _auth_ok(request)
    content = json.dumps(redact(raw), indent=2, sort_keys=True, default=str)
    return Response(content=content, media_type="application/json")


@app.get("/debug/shapes", include_in_schema=False)
def debug_shapes(request: Request) -> dict:
    """Collected field shapes (names + type names only, never values), keyed
    by brand:region:powertrain — see shape_capture.py. Developer-only:
    requires the SHAPES_DEBUG_TOKEN env var to be set AND matched by the
    X-Debug-Token header. 404 (not 401/403) otherwise, so the endpoint's
    existence isn't advertised to scanners."""
    expected = os.environ.get("SHAPES_DEBUG_TOKEN")
    provided = request.headers.get("x-debug-token", "")
    if not expected or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=404, detail="Not Found")
    return shape_capture.store.snapshot()


def _send_command(request: Request, creds: Credentials, fn) -> CommandAccepted:
    session = _session(request, creds)
    try:
        fn(session.provider)
    except ReenrollRequired as exc:
        raise _reenroll_needed(request, session, exc)
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


# -- Kia-US OTP enrollment ---------------------------------------------------
# These endpoints exist only because Kia-US (brand=1, region=3) requires a
# device-trust OTP on first login. Other brand/region combos never need them.
# The flow is: start → user receives email/SMS code → verify → phone stores
# the returned device_token and sends it with every subsequent request.

KIA_US_BRAND = 1  # const.BRAND_KIA
KIA_US_REGION = 3  # const.REGION_USA


class EnrollStartBody(CredentialedRequest):
    notify_type: str = Field(
        default="EMAIL",
        description="How to send the OTP: EMAIL or SMS",
        pattern="^(EMAIL|SMS)$",
    )


class EnrollVerifyBody(CredentialedRequest):
    code: str = Field(min_length=1, description="The OTP code from the email/SMS")


def _require_kia_us(creds: Credentials) -> None:
    if creds.brand != KIA_US_BRAND or creds.region != KIA_US_REGION:
        raise HTTPException(
            status_code=400,
            detail="Device enrollment is only required for Kia + USA. "
            f"Got brand={creds.brand} region={creds.region}.",
        )


@app.post("/kia-us/enroll/start")
@limiter.limit(RATE_EXPENSIVE)
def enroll_start(body: EnrollStartBody, request: Request) -> dict:
    """Kick off Kia-US OTP device enrollment. Returns masked destinations
    (email/phone) or ``{"enrolled": true}`` if already trusted."""
    _require_kia_us(body.credentials)
    # Per-credential throttle: 3/hour — prevents OTP spam to someone else's
    # email/SMS. Separate from (and tighter than) the per-IP rate limiter.
    session = _session(request, body.credentials)
    throttle = request.app.state.enroll_throttles.get(session.key)
    allowed, retry_after = throttle.try_acquire()
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="enrollment rate limited — too many OTP requests for this account",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        return session.provider.start_enrollment(body.notify_type)
    except AuthError as exc:
        raise _auth_failed(request, session, exc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}")


@app.post("/kia-us/enroll/verify")
@limiter.limit(RATE_EXPENSIVE)
def enroll_verify(body: EnrollVerifyBody, request: Request) -> dict:
    """Verify the OTP code and return the device_token for phone storage."""
    _require_kia_us(body.credentials)
    session = _session(request, body.credentials)
    try:
        return session.provider.verify_enrollment(body.code)
    except ReenrollRequired as exc:
        # Session expired between /start and /verify — tell client to restart.
        raise _reenroll_needed(request, session, exc)
    except AuthError as exc:
        raise _auth_failed(request, session, exc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}")
