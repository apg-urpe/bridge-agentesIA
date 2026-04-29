r"""Tests unitarios del API del bridge.
Cada test usa una DB temporal (ver conftest.py) — totalmente aislado.

Correr con: docker compose exec bridge python -m pytest tests/ -v
       o:   .\scripts\run-pytest.ps1
"""
import pytest
from .conftest import register_agent


# ---------- health & basic endpoints ----------

def test_health(client):
    r = client.get("/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_status_page(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "bridge-agentesIA" in r.text


def test_office_page(client):
    r = client.get("/office")
    assert r.status_code == 200
    assert "office" in r.text.lower()


# ---------- agent registration ----------

def test_register_agent(client):
    data = register_agent(client, "rocky", "Rocky", "Telegram")
    assert data["agent_id"] == "rocky"
    assert data["display_name"] == "Rocky"
    assert data["platform"] == "Telegram"
    assert "api_key" in data and len(data["api_key"]) > 20
    assert data["trusted"] is False


def test_register_duplicate_agent_fails(client):
    register_agent(client, "rocky")
    r = client.post(
        "/v1/agents/register",
        json={"agent_id": "rocky", "display_name": "Rocky2"},
    )
    assert r.status_code == 409


def test_list_agents_public(client):
    register_agent(client, "rocky")
    register_agent(client, "pepper")
    r = client.get("/v1/agents")
    assert r.status_code == 200
    ids = [a["agent_id"] for a in r.json()]
    assert "rocky" in ids and "pepper" in ids


def test_whoami_without_api_key_rejected(client):
    # without the X-API-Key header FastAPI devuelve 422 (Header(...) required)
    r = client.get("/v1/me")
    assert r.status_code == 422


def test_whoami_with_invalid_api_key_rejected(client):
    register_agent(client, "rocky")
    r = client.get("/v1/me", headers={"X-API-Key": "wrong-key"})
    assert r.status_code == 401


def test_whoami_returns_self(client):
    pepper = register_agent(client, "pepper")
    r = client.get("/v1/me", headers={"X-API-Key": pepper["api_key"]})
    assert r.status_code == 200
    assert r.json()["agent_id"] == "pepper"


# ---------- send / inbox / threads ----------

def test_send_message_basic(client):
    rocky = register_agent(client, "rocky")
    register_agent(client, "pepper")
    r = client.post(
        "/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "rocky", "to_agent": "pepper", "message": "hola"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "queued"
    assert "message_id" in body


def test_send_requires_correct_from_agent(client):
    rocky = register_agent(client, "rocky")
    register_agent(client, "pepper")
    # rocky's key trying to send as pepper
    r = client.post(
        "/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "pepper", "to_agent": "rocky", "message": "x"},
    )
    assert r.status_code == 403


def test_send_to_unknown_agent_fails(client):
    rocky = register_agent(client, "rocky")
    r = client.post(
        "/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "rocky", "to_agent": "ghost", "message": "x"},
    )
    assert r.status_code == 404


def test_inbox_returns_pending_for_recipient(client):
    rocky = register_agent(client, "rocky")
    pepper = register_agent(client, "pepper")
    client.post("/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "rocky", "to_agent": "pepper", "message": "ping"})
    r = client.get("/v1/inbox/pepper",
        headers={"X-API-Key": pepper["api_key"]})
    assert r.status_code == 200
    msgs = r.json()
    assert len(msgs) == 1
    assert msgs[0]["from_agent"] == "rocky"
    assert msgs[0]["message"] == "ping"


def test_inbox_blocks_other_agents(client):
    rocky = register_agent(client, "rocky")
    register_agent(client, "pepper")
    r = client.get("/v1/inbox/pepper",
        headers={"X-API-Key": rocky["api_key"]})
    assert r.status_code == 403


def test_ack_marks_message_read(client):
    rocky = register_agent(client, "rocky")
    pepper = register_agent(client, "pepper")
    sr = client.post("/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "rocky", "to_agent": "pepper", "message": "ping"})
    mid = sr.json()["message_id"]
    r = client.post(f"/v1/messages/{mid}/ack",
        headers={"X-API-Key": pepper["api_key"]})
    assert r.status_code == 200

    # ahora el inbox no debe traerlo (unread_only=True por default)
    r2 = client.get("/v1/inbox/pepper",
        headers={"X-API-Key": pepper["api_key"]})
    assert r2.json() == []


def test_threads_groups_messages_by_thread_id(client):
    rocky = register_agent(client, "rocky")
    register_agent(client, "pepper")
    for i in range(3):
        client.post("/v1/send",
            headers={"X-API-Key": rocky["api_key"]},
            json={"from_agent": "rocky", "to_agent": "pepper",
                  "message": f"m{i}", "thread_id": "t1"})
    r = client.get("/v1/threads",
        headers={"X-API-Key": rocky["api_key"]})
    assert r.status_code == 200
    threads = r.json()["threads"]
    assert len(threads) == 1
    assert threads[0]["thread_id"] == "t1"
    assert threads[0]["message_count"] == 3


# ---------- self-service appearance ----------

def test_appearance_defaults_are_null(client):
    rocky = register_agent(client, "rocky")
    me = client.get("/v1/me", headers={"X-API-Key": rocky["api_key"]}).json()
    assert me["palette"] is None
    assert me["hue_shift"] is None


def test_appearance_update_persists(client):
    rocky = register_agent(client, "rocky")
    r = client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"palette": 3, "hue_shift": 120},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["palette"] == 3
    assert body["hue_shift"] == 120

    # Should also surface in /v1/me and /v1/agents
    me = client.get("/v1/me", headers={"X-API-Key": rocky["api_key"]}).json()
    assert me["palette"] == 3 and me["hue_shift"] == 120
    listing = client.get("/v1/agents").json()
    rocky_listed = next(a for a in listing if a["agent_id"] == "rocky")
    assert rocky_listed["palette"] == 3
    assert rocky_listed["hue_shift"] == 120


def test_appearance_partial_update(client):
    rocky = register_agent(client, "rocky")
    client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"palette": 2, "hue_shift": 90},
    )
    # Update only hue_shift; palette must persist
    r = client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"hue_shift": 200},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["palette"] == 2
    assert body["hue_shift"] == 200


def test_appearance_clear_resets_to_null(client):
    rocky = register_agent(client, "rocky")
    client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"palette": 5, "hue_shift": 300},
    )
    r = client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"clear": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["palette"] is None
    assert body["hue_shift"] is None


def test_appearance_empty_payload_rejected(client):
    rocky = register_agent(client, "rocky")
    r = client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={},
    )
    assert r.status_code == 400


def test_appearance_invalid_palette_rejected(client):
    rocky = register_agent(client, "rocky")
    r = client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"palette": 99},
    )
    assert r.status_code == 422  # pydantic range


def test_appearance_invalid_hue_rejected(client):
    rocky = register_agent(client, "rocky")
    r = client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"hue_shift": -10},
    )
    assert r.status_code == 422


def test_appearance_requires_auth(client):
    register_agent(client, "rocky")
    r = client.patch("/v1/me/appearance", json={"palette": 0})
    assert r.status_code == 422  # missing X-API-Key header


def test_appearance_isolated_per_agent(client):
    rocky = register_agent(client, "rocky")
    pepper = register_agent(client, "pepper")
    client.patch(
        "/v1/me/appearance",
        headers={"X-API-Key": rocky["api_key"]},
        json={"palette": 4, "hue_shift": 45},
    )
    # Pepper is unaffected
    me = client.get("/v1/me", headers={"X-API-Key": pepper["api_key"]}).json()
    assert me["palette"] is None
    assert me["hue_shift"] is None


# ---------- gate ----------

def test_gate_status_open_when_no_token(client):
    r = client.get("/v1/gate/status")
    assert r.json() == {"required": False}


def test_gate_status_required_when_token_set(gated_client):
    client, _ = gated_client
    r = client.get("/v1/gate/status")
    assert r.json() == {"required": True}


def test_gate_check_rejects_bad_token(gated_client):
    client, _ = gated_client
    r = client.post("/v1/gate/check",
        headers={"X-Registration-Token": "wrong"})
    assert r.status_code == 401


def test_gate_check_accepts_correct_token(gated_client):
    client, token = gated_client
    r = client.post("/v1/gate/check",
        headers={"X-Registration-Token": token})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_register_requires_gate_token_when_set(gated_client):
    client, _ = gated_client
    r = client.post("/v1/agents/register",
        json={"agent_id": "rocky", "display_name": "Rocky"})
    assert r.status_code == 401


def test_register_works_with_correct_gate_token(gated_client):
    client, token = gated_client
    data = register_agent(client, "rocky", token=token)
    assert data["agent_id"] == "rocky"


# ---------- office feed (SSE) ----------
# El endpoint es un stream infinito (while True). TestClient sincroniza con
# asyncio internamente y se cuelga al cerrar context managers de streams 200.
# Por eso solo testeamos los caminos de auth (que devuelven 401 antes del
# stream y no se cuelgan).
# Para validar que el feed emite eventos reales, ver el test E2E
# `test_feed_live.py` que usa httpx contra el container corriendo.

def test_office_feed_requires_gate_token_when_gated(gated_client):
    client, _ = gated_client
    with client.stream("GET", "/v1/office/feed") as r:
        assert r.status_code == 401
    with client.stream("GET", "/v1/office/feed", params={"token": "wrong"}) as r:
        assert r.status_code == 401


@pytest.mark.skip(reason="TestClient + stream(while True) cuelga; ver test_feed_live")
def test_office_feed_open_with_correct_token(gated_client):
    client, token = gated_client
    with client.stream("GET", "/v1/office/feed", params={"token": token}) as r:
        assert r.status_code == 200


@pytest.mark.skip(reason="TestClient + stream(while True) cuelga; ver test_feed_live")
def test_office_feed_open_when_not_gated(client):
    with client.stream("GET", "/v1/office/feed") as r:
        assert r.status_code == 200
