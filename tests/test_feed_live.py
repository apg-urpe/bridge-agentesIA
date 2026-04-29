"""Tests E2E del feed SSE — corren contra el bridge realmente levantado
(no TestClient, que se cuelga con streams `while True`).

Skipean si el bridge no responde en BRIDGE_URL, o si el gate está
activado y no hay BRIDGE_GATE_TOKEN seteado.

Correr con:  docker compose exec bridge python -m pytest tests/ -v
"""
import json
import os
import secrets
import sqlite3
import threading
import time

import httpx
import pytest


BRIDGE_URL = os.getenv("BRIDGE_URL", "http://localhost:8000")
GATE_TOKEN = os.getenv("BRIDGE_GATE_TOKEN", "").strip()
DB_PATH = os.getenv("DATABASE_URL", "/app/data/bridge.db")


def _bridge_alive() -> bool:
    try:
        return httpx.get(f"{BRIDGE_URL}/v1/health", timeout=2).status_code == 200
    except Exception:
        return False


def _gate_required() -> bool:
    try:
        r = httpx.get(f"{BRIDGE_URL}/v1/gate/status", timeout=2)
        return bool(r.json().get("required"))
    except Exception:
        return False


# Skipea todos los tests si el bridge no responde.
pytestmark = pytest.mark.skipif(
    not _bridge_alive(),
    reason=f"bridge no responde en {BRIDGE_URL} (setear BRIDGE_URL si es otro)",
)


def _feed_url() -> str:
    if GATE_TOKEN:
        return f"{BRIDGE_URL}/v1/office/feed?token={GATE_TOKEN}"
    return f"{BRIDGE_URL}/v1/office/feed"


def _register_headers() -> dict:
    return {"X-Registration-Token": GATE_TOKEN} if GATE_TOKEN else {}


def _register(agent_id: str, display_name: str) -> dict:
    r = httpx.post(
        f"{BRIDGE_URL}/v1/agents/register",
        json={"agent_id": agent_id, "display_name": display_name, "platform": "test"},
        headers=_register_headers(),
        timeout=5,
    )
    assert r.status_code == 201, f"register {agent_id}: {r.status_code} {r.text}"
    return r.json()


def test_feed_emits_hello_event():
    """Al conectar, el server emite un evento 'hello'."""
    with httpx.stream("GET", _feed_url(), timeout=5) as r:
        assert r.status_code == 200, r.text
        assert "text/event-stream" in r.headers["content-type"]
        for chunk in r.iter_text():
            if "hello" in chunk:
                return
        pytest.fail("no llegó el evento 'hello' inicial")


def _cleanup_agents(*agent_ids: str) -> None:
    """Borrar agentes y mensajes asociados directamente de la DB.

    El bridge no expone un endpoint `DELETE` de agentes (solo PATCH
    revoked=1, que requiere ADMIN_TOKEN). Como este test corre dentro del
    container con acceso al volumen, limpiamos vía sqlite3 para no dejar
    `Feed Sender / Feed Receiver` colgados en la oficina.
    """
    if not agent_ids or not os.path.exists(DB_PATH):
        return
    try:
        with sqlite3.connect(DB_PATH) as db:
            placeholders = ",".join("?" * len(agent_ids))
            db.execute(f"DELETE FROM agents WHERE agent_id IN ({placeholders})", agent_ids)
            db.execute(
                f"DELETE FROM messages WHERE from_agent IN ({placeholders}) "
                f"OR to_agent IN ({placeholders})",
                agent_ids + agent_ids,
            )
            db.commit()
    except sqlite3.Error:
        pass  # Best effort — never fail a test on cleanup.


def test_feed_emits_message_after_send():
    """Tras un POST /v1/send, el feed SSE debe emitir el mensaje en vivo."""
    if _gate_required() and not GATE_TOKEN:
        pytest.skip("gate activo y no hay BRIDGE_GATE_TOKEN en el entorno")

    suffix = secrets.token_hex(4)
    sender_id = f"feedtest-{suffix}-a"
    receiver_id = f"feedtest-{suffix}-b"

    try:
        sender = _register(sender_id, "Feed Sender")
        _register(receiver_id, "Feed Receiver")

        body_text = f"hello-{suffix}"
        received: list[dict] = []
        error: list[str] = []

        def reader() -> None:
            try:
                with httpx.stream("GET", _feed_url(), timeout=15) as r:
                    if r.status_code != 200:
                        error.append(f"feed status {r.status_code}: {r.text}")
                        return
                    buf = ""
                    for chunk in r.iter_text():
                        buf += chunk
                        while "\n\n" in buf:
                            raw, buf = buf.split("\n\n", 1)
                            for line in raw.splitlines():
                                if not line.startswith("data: "):
                                    continue
                                try:
                                    payload = json.loads(line[len("data: "):])
                                except json.JSONDecodeError:
                                    continue
                                if payload.get("type") == "message" and payload.get("message") == body_text:
                                    received.append(payload)
                                    return
            except Exception as e:
                error.append(f"reader exc: {e}")

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        # Give the SSE stream a moment to anchor `last_seen` before we send.
        time.sleep(0.5)

        send = httpx.post(
            f"{BRIDGE_URL}/v1/send",
            headers={"X-API-Key": sender["api_key"]},
            json={"from_agent": sender_id, "to_agent": receiver_id, "message": body_text},
            timeout=5,
        )
        assert send.status_code == 200, f"send: {send.status_code} {send.text}"
        sent_id = send.json()["message_id"]

        t.join(timeout=10)
        assert not error, error[0]
        assert received, "el feed no emitió el mensaje en 10s"
        payload = received[0]
        assert payload["from"] == sender_id
        assert payload["to"] == receiver_id
        assert payload["id"] == sent_id
    finally:
        _cleanup_agents(sender_id, receiver_id)
