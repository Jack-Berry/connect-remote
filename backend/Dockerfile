# Self-host / VPS fallback. Render deploys don't use this (see /render.yaml).
#
#   docker build -t connect-remote-backend backend/
#   docker run -d --env-file backend/.env -p 8000:8000 connect-remote-backend
#
# Put HTTPS in front (Caddy/Traefik/nginx) before exposing it to the internet.

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# pyproject.toml pins hyundai_kia_connect_api==4.15.0 — see the comment there
# before bumping it.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
