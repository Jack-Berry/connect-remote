# Decisions log

Significant product/architecture decisions, newest first. One entry per
decision: what changed, why, and what it rules out.

## 2026-07-14 — Hosted stateless proxy replaces bring-your-own backend

**Decision:** the app talks to a single hosted proxy at
`car-proxy.berrydev.co.uk` (our VPS). Users enter their Connected Services
credentials (username, password, PIN, region) in the app's phone settings;
they are stored only in the Even app's local storage on the phone and sent
per-request to the proxy. The proxy is stateless apart from a short-lived
in-memory session cache (10 min TTL, keyed by a SHA-256 of the credentials,
never persisted, never logged). The self-hosted Render "deploy your own
backend" flow is retired.

**Why:** the Even Hub store's `network` permission whitelist requires
exact-match domains — no wildcards, no per-user hostnames (confirmed via
community docs). A BYO backend gives every user a different Render URL, which
cannot be whitelisted, so the store model forces a fixed domain. All approved
car apps in the store use the same pattern: hosted proxy + credentials stored
locally on the phone.

**Consequences:**
- `app.json` whitelists exactly one domain: `car-proxy.berrydev.co.uk`.
- The static bearer token and env-var credentials are gone; auth is the
  Connected Services credentials themselves, per request over HTTPS.
- The proxy never writes credentials to disk or logs; a proxy restart just
  means the next request does a full login.
- Render deployment (`render.yaml`, cold-start wake logic in the app) is
  removed. Transient EU-endpoint login-rejection retries stay — that is a
  Hyundai/Kia platform quirk, not a Render one.
- Hosting: DigitalOcean VPS, Ubuntu 24.04, Docker Compose (Caddy for TLS +
  the FastAPI proxy, internal-only).
