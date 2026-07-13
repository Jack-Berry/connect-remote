import json
import logging
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .config import settings
from .providers.base import (
    ClimateSettings,
    CommandProvider,
    ProviderDataError,
    StatusProvider,
    UpstreamError,
    VehicleStatus,
)
from .rate_limit import RefreshThrottle
from .redact import redact

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _build_provider():
    # Imported lazily so tests can run without Genesis credentials/lib setup.
    from .providers.genesis import GenesisProvider

    return GenesisProvider(
        username=settings.username,
        password=settings.password,
        pin=settings.pin,
        region=settings.region,
        brand=settings.brand,
    )


class AppState:
    """Wires providers + throttle; swapped out wholesale in tests."""

    def __init__(
        self,
        status_provider: StatusProvider,
        command_provider: CommandProvider,
        throttle: RefreshThrottle,
    ):
        self.status_provider = status_provider
        self.command_provider = command_provider
        self.throttle = throttle
        self.last_known: VehicleStatus | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Free-tier hosts sleep when idle and cold-start on the next request.
    The Genesis login is the slow, flaky part of a cold start, so kick it
    off the moment the process boots instead of inside that first request.
    Skipped when wiring was injected already (tests)."""
    if not hasattr(app.state, "wiring"):
        threading.Thread(target=_warm_up, name="genesis-warmup", daemon=True).start()
    yield


def _warm_up() -> None:
    t0 = time.monotonic()
    try:
        state = get_state()
        state.last_known = state.status_provider.get_cached_status()
        logger.info("timing: Genesis warm-up complete in %.1fs", time.monotonic() - t0)
    except Exception as exc:
        logger.warning(
            "Genesis warm-up failed after %.1fs; first request will retry: %s",
            time.monotonic() - t0, exc,
        )


app = FastAPI(title="genesis-g2-backend", docs_url=None, redoc_url=None, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

_bearer = HTTPBearer(auto_error=False)


def require_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    if credentials is None or not secrets.compare_digest(
        credentials.credentials, settings.api_token
    ):
        raise HTTPException(status_code=401, detail="invalid or missing token")


# The warm-up thread and the first request can race to build the provider;
# two concurrent Genesis logins is exactly the rate-limit trap we're avoiding.
_wiring_lock = threading.Lock()


def get_state() -> AppState:
    with _wiring_lock:
        if not hasattr(app.state, "wiring"):
            provider = _build_provider()
            app.state.wiring = AppState(
                status_provider=provider,
                command_provider=provider,
                throttle=RefreshThrottle(
                    settings.refresh_min_interval_seconds, settings.refresh_daily_cap
                ),
            )
    return app.state.wiring


class ClimateBody(BaseModel):
    on: bool
    temp: float = Field(default=21.0, ge=14, le=30)
    defrost: bool = False
    heating: bool = False


class ChargeBody(BaseModel):
    on: bool


class ChargeLimitsBody(BaseModel):
    # Genesis accepts 50–100% in 10% steps; validate the range and let the
    # car reject odd steps rather than second-guessing per-model rules.
    ac: int = Field(ge=50, le=100)
    dc: int = Field(ge=50, le=100)


class CommandAccepted(BaseModel):
    sent: bool = True
    note: str = "Command sent. The car takes 30-90 s to apply it; re-poll /status after a delay."
    sent_at: datetime


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_bug_response(exc: ProviderDataError) -> HTTPException:
    # 500, not 502: the glasses/phone apps map 502 to "Genesis unreachable",
    # which sends users chasing credentials/network for what is our bug.
    logger.error("provider data parse failure (backend bug): %s", exc)
    return HTTPException(
        status_code=500,
        detail=f"backend could not parse Genesis data — backend bug, please report: {exc}",
    )


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict:
    """Unauthenticated liveness probe for Render/Docker health checks.
    Must not touch Genesis — it runs every few seconds. Exposes the deployed
    commit (Render sets RENDER_GIT_COMMIT) so a push can be confirmed live."""
    return {"ok": True, "commit": os.environ.get("RENDER_GIT_COMMIT")}


@app.get("/status", response_model=VehicleStatus, dependencies=[Depends(require_token)])
def get_status(state: AppState = Depends(get_state)) -> VehicleStatus:
    try:
        status = state.status_provider.get_cached_status()
        state.last_known = status
        return status
    except ProviderDataError as exc:
        # Genesis answered but we couldn't decode it — a backend bug, not an
        # outage. Surface it loudly instead of masking it with stale data;
        # the glasses app keeps showing last-known values client-side anyway.
        raise _parse_bug_response(exc)
    except UpstreamError as exc:
        # Degrade gracefully: serve last-known state marked stale, not a 500.
        if state.last_known is not None:
            logger.warning("upstream failed, serving stale status: %s", exc)
            return state.last_known.model_copy(update={"stale": True})
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")


# The token stays in a fetch header: putting it in the URL would leak a
# car-unlocking secret into browser history and the host's access logs.
_DEBUG_PAGE = """<!doctype html>
<title>Vehicle fields</title>
<body style="font-family: system-ui; margin: 2rem; max-width: 60rem">
<h1>Vehicle fields</h1>
<p>Paste your API token to dump every field your car reports, then send the
result to whoever asked for it. The VIN and location are redacted.</p>
<input id="t" type="password" size="40" placeholder="API token">
<button onclick="go()">Show fields</button>
<pre id="out" style="white-space: pre-wrap; background: #f4f4f4; padding: 1rem"></pre>
<script>
async function go() {
  const out = document.getElementById('out');
  out.textContent = 'Loading… (a sleeping backend can take a minute)';
  try {
    const r = await fetch('/debug/fields', {
      headers: {Authorization: 'Bearer ' + document.getElementById('t').value},
    });
    out.textContent = (r.ok ? '' : 'HTTP ' + r.status + '\\n\\n') + await r.text();
  } catch (e) {
    out.textContent = 'Request failed: ' + e;
  }
}
</script>
"""


@app.get("/debug", include_in_schema=False)
def debug_page() -> Response:
    """Unauthenticated shell only — it holds no data; /debug/fields below still
    demands the token. Exists because a browser address bar can't send an
    Authorization header, and the users who need this dump don't have curl."""
    return Response(content=_DEBUG_PAGE, media_type="text/html")


@app.get("/debug/fields", dependencies=[Depends(require_token)], include_in_schema=False)
def debug_fields(state: AppState = Depends(get_state)) -> Response:
    """Redacted dump of every field the car reports, for users to paste into a
    bug report — especially a parse failure, or a non-Genesis car whose fields
    we've never seen. No response_model on purpose: this must survive the data
    that VehicleStatus chokes on. Pretty-printed to read in a browser."""
    try:
        raw = state.status_provider.get_raw_fields()
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")
    body = json.dumps(redact(raw), indent=2, sort_keys=True, default=str)
    return Response(content=body, media_type="application/json")


@app.post("/refresh", response_model=VehicleStatus, dependencies=[Depends(require_token)])
def force_refresh(response: Response, state: AppState = Depends(get_state)) -> VehicleStatus:
    allowed, retry_after = state.throttle.try_acquire()
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="force refresh throttled",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        status = state.status_provider.force_refresh()
        state.last_known = status
        return status
    except ProviderDataError as exc:
        raise _parse_bug_response(exc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")


@app.post("/climate", response_model=CommandAccepted, dependencies=[Depends(require_token)])
def climate(body: ClimateBody, state: AppState = Depends(get_state)) -> CommandAccepted:
    try:
        state.command_provider.set_climate(
            ClimateSettings(
                on=body.on, temp=body.temp, defrost=body.defrost, heating=body.heating
            )
        )
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")
    return CommandAccepted(sent_at=_now())


# Siri-friendly climate presets: one URL per phrase, so a Shortcut is a bare
# POST with no JSON body to assemble. Edit temps/flags here to taste.
CLIMATE_PRESETS: dict[str, ClimateSettings] = {
    "cool": ClimateSettings(on=True, temp=17.0),
    "warm": ClimateSettings(on=True, temp=24.0),
    # Frosty mornings: warm + windscreen defrost + rear window/steering heat
    "defrost": ClimateSettings(on=True, temp=24.0, defrost=True, heating=True),
}


@app.post(
    "/presets/{name}", response_model=CommandAccepted, dependencies=[Depends(require_token)]
)
def climate_preset(name: str, state: AppState = Depends(get_state)) -> CommandAccepted:
    preset = CLIMATE_PRESETS.get(name)
    if preset is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown preset; available: {', '.join(sorted(CLIMATE_PRESETS))}",
        )
    try:
        state.command_provider.set_climate(preset)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")
    return CommandAccepted(sent_at=_now())


@app.post("/charge", response_model=CommandAccepted, dependencies=[Depends(require_token)])
def charge(body: ChargeBody, state: AppState = Depends(get_state)) -> CommandAccepted:
    try:
        if body.on:
            state.command_provider.start_charge()
        else:
            state.command_provider.stop_charge()
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")
    return CommandAccepted(sent_at=_now())


@app.post(
    "/charge-limits", response_model=CommandAccepted, dependencies=[Depends(require_token)]
)
def charge_limits(body: ChargeLimitsBody, state: AppState = Depends(get_state)) -> CommandAccepted:
    try:
        state.command_provider.set_charge_limits(body.ac, body.dc)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")
    return CommandAccepted(sent_at=_now())


@app.post("/lock", response_model=CommandAccepted, dependencies=[Depends(require_token)])
def lock(state: AppState = Depends(get_state)) -> CommandAccepted:
    try:
        state.command_provider.lock()
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")
    return CommandAccepted(sent_at=_now())


@app.post("/unlock", response_model=CommandAccepted, dependencies=[Depends(require_token)])
def unlock(state: AppState = Depends(get_state)) -> CommandAccepted:
    try:
        state.command_provider.unlock()
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Genesis upstream error: {exc}")
    return CommandAccepted(sent_at=_now())
