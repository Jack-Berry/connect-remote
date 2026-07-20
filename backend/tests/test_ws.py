"""Keepalive WebSocket (/ws) — the car-finder's suspension-defeating socket.

It carries nothing, so the whole contract is: accepts connections, heartbeats,
notices disconnects promptly, and caps connections per IP (slowapi's HTTP
rate limiter never sees WebSocket handshakes, so the cap is the only guard).
"""

from contextlib import ExitStack

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import main as app_main
from app.main import app


@pytest.fixture(autouse=True)
def clean_slate():
    app_main._ws_connections.clear()
    yield
    app_main._ws_connections.clear()


def test_accepts_and_heartbeats(monkeypatch):
    monkeypatch.setattr(app_main, "WS_HEARTBEAT_SECONDS", 0.05)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            assert ws.receive_text() == "ka"
            assert ws.receive_text() == "ka"


def test_ignores_client_payloads(monkeypatch):
    monkeypatch.setattr(app_main, "WS_HEARTBEAT_SECONDS", 0.05)
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_text("anything")
            # Still alive and heartbeating afterwards.
            assert ws.receive_text() == "ka"


def test_caps_connections_per_ip():
    with TestClient(app) as client:
        with ExitStack() as stack:
            for _ in range(app_main.WS_MAX_CONNECTIONS_PER_IP):
                stack.enter_context(client.websocket_connect("/ws"))
            # One over the cap: closed before accept with 1013 (try later).
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect("/ws"):
                    pass
            assert exc.value.code == 1013

        # Closing them released the slots: a fresh connection is welcome.
        with client.websocket_connect("/ws"):
            pass
        assert app_main._ws_connections == {}
