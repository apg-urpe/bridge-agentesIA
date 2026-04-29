"""Fixtures compartidas. Cada test corre contra una DB SQLite temporal,
así no toca la DB real del bridge.
"""
import os
import secrets
import tempfile
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    """Cliente FastAPI con DB temporal por test."""
    tmpdir = tempfile.mkdtemp(prefix="bridge-test-")
    db_path = os.path.join(tmpdir, "bridge.db")
    monkeypatch.setenv("DATABASE_URL", db_path)
    monkeypatch.setenv("REGISTRATION_TOKEN", "")
    monkeypatch.setenv("ADMIN_TOKEN", "")

    # Re-importar app después de monkeypatch para que tome la DB temporal.
    import importlib
    from app import database, main
    importlib.reload(database)
    importlib.reload(main)

    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def gated_client(monkeypatch):
    """Cliente con REGISTRATION_TOKEN seteado."""
    tmpdir = tempfile.mkdtemp(prefix="bridge-test-")
    db_path = os.path.join(tmpdir, "bridge.db")
    monkeypatch.setenv("DATABASE_URL", db_path)
    monkeypatch.setenv("REGISTRATION_TOKEN", "test-gate-token-xyz")
    monkeypatch.setenv("ADMIN_TOKEN", "")

    import importlib
    from app import database, main
    importlib.reload(database)
    importlib.reload(main)

    with TestClient(main.app) as c:
        yield c, "test-gate-token-xyz"


def register_agent(client, agent_id, display_name=None, platform="test", token=None):
    """Helper: registra un agente y devuelve {agent_id, api_key}."""
    headers = {}
    if token:
        headers["X-Registration-Token"] = token
    r = client.post(
        "/v1/agents/register",
        json={
            "agent_id": agent_id,
            "display_name": display_name or agent_id.title(),
            "platform": platform,
        },
        headers=headers,
    )
    assert r.status_code == 201, f"register failed: {r.status_code} {r.text}"
    return r.json()
