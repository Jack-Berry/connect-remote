# Deploying the hosted proxy

The proxy serves all users at `https://car-proxy.berrydev.co.uk` — a
DigitalOcean VPS (Ubuntu 24.04, 178.128.168.63) running two containers via
Docker Compose:

- **caddy** — terminates TLS (auto-HTTPS via Let's Encrypt), reverse-proxies
  to the app. Ports 80/443. Access logs disabled ([Caddyfile](Caddyfile)).
- **proxy** — the FastAPI app. No published ports; reachable only from Caddy
  on the internal compose network.

The proxy is stateless (see `/DECISIONS-LOG.md`): no database, no volumes, no
credentials at rest. Restarts and redeploys lose nothing but the in-memory
session cache — the next request from each user just logs in afresh.

## One-time server setup

1. Create the DNS A record `car-proxy.berrydev.co.uk → 178.128.168.63` and
   wait for it to resolve (Let's Encrypt needs it on first start).
2. SSH in as root and work through [server-setup.sh](server-setup.sh)
   **section by section** — it sets up the firewall, unattended upgrades,
   Docker, and the `deploy` user, then (commented out, run last, only after
   verifying `ssh deploy@…` works) disables root SSH login and password auth.

## First deploy

As the `deploy` user:

```sh
git clone https://github.com/jack-berry/connect-remote.git
cd connect-remote
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

Verify from anywhere:

```sh
curl https://car-proxy.berrydev.co.uk/healthz
# {"ok":true,"commit":"<sha>"}   <- sha matches what you just deployed
```

First `curl` after start can take a few seconds while Caddy finishes the
ACME handshake.

## Deploying an update

```sh
ssh deploy@car-proxy.berrydev.co.uk
cd connect-remote
git pull
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
curl -s https://car-proxy.berrydev.co.uk/healthz   # confirm the new sha
```

`docker compose up -d --build` rebuilds the proxy image and replaces only the
containers whose configuration changed; Caddy stays up (and keeps its certs —
they live in the `caddy-data` volume) unless the Caddyfile changed.

There is a brief (~seconds) proxy outage while the container swaps. Clients
retry, and the session cache being dropped only costs each user one fresh
login.

## Logs & operations

```sh
docker compose logs -f proxy    # method/path/status/latency lines only
docker compose logs -f caddy    # cert lifecycle etc. — no access logs
docker compose ps               # health status ("healthy" = /healthz OK)
docker compose restart proxy    # drops session cache; users just re-login
```

The proxy never logs request bodies, headers, or query strings — nothing
credential-shaped reaches the logs. Keep it that way when adding log lines.

## Rollback

```sh
git log --oneline -5
git checkout <known-good-sha>
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```
