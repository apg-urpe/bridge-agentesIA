"""Test E2E del feed SSE: usa httpx contra el bridge corriendo (no TestClient,
que se cuelga con streams `while True`). Skipea automáticamente si el
bridge no está accesible en BRIDGE_URL.

Correr con:  docker compose exec bridge python -m pytest tests/ -v
"""
import os
import pytest
import httpx


BRIDGE_URL = os.getenv("BRIDGE_URL", "http://localhost:8000")


def _bridge_alive() -> bool:
    try:
        return httpx.get(f"{BRIDGE_URL}/v1/health", timeout=2).status_code == 200
    except Exception:
        return False


# Skipea todos los tests de este módulo si el bridge no responde.
pytestmark = pytest.mark.skipif(
    not _bridge_alive(),
    reason=f"bridge no responde en {BRIDGE_URL} (setear BRIDGE_URL si es otro)",
)


def test_feed_emits_hello_event():
    """Al conectar, el server emite un evento 'hello'."""
    with httpx.stream("GET", f"{BRIDGE_URL}/v1/office/feed", timeout=5) as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers["content-type"]
        for chunk in r.iter_text():
            if "hello" in chunk:
                return
        pytest.fail("no llegó el evento 'hello' inicial")
