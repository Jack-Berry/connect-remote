# Proxy image. Built by /docker-compose.yml on the VPS — see deploy/README.md.
#
# Local build for poking at it:
#   docker build -t connect-remote-proxy --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) backend/

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# pyproject.toml pins hyundai_kia_connect_api==4.15.0 — see the comment there
# before bumping it.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .

# /data is the shapes volume mount point (compose). Creating it appuser-owned
# in the image matters: Docker initializes a FRESH named volume from the
# image's directory — ownership included — so first boot on a clean host gets
# a writable /data with no entrypoint chown. An EXISTING root-owned volume
# keeps its ownership (this bit prod 16–19 Jul: every dump failed EACCES);
# fix those once with:  docker compose exec -u root proxy chown appuser /data
RUN useradd --create-home appuser && mkdir /data && chown appuser:appuser /data
USER appuser

# Surfaced by /healthz so a deploy can be confirmed live.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"

# Exactly one worker: the session cache and throttles live in process memory,
# so a second worker would split them (logins doubled, throttles halved).
# --no-access-log: uvicorn's access log records the request line; our own
# middleware logs method/path/status/latency and nothing else.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
