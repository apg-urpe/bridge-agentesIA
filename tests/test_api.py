r"""Tests unitarios del API del bridge.
Cada test usa una DB temporal (ver conftest.py) — totalmente aislado.

Correr con: docker compose exec bridge python -m pytest tests/ -v
       o:   .\scripts\run-pytest.ps1
"""
import base64
import hashlib
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


# ---------- attachments ----------

def test_attachments_roundtrip_binary_and_text(client):
    """Send a message with two attachments (binary + text/UTF-8) and verify
    the receiver gets them byte-for-byte via /v1/inbox and /v1/threads."""
    rocky = register_agent(client, "rocky")
    pepper = register_agent(client, "pepper")

    raw_bin = bytes(range(256)) * 8  # 2048 bytes, full byte range
    sha_in = hashlib.sha256(raw_bin).hexdigest()
    txt = "Hola desde Rocky\nLínea 2 con tildes: áéíóú\n"

    r = client.post(
        "/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={
            "from_agent": "rocky", "to_agent": "pepper",
            "message": "con dos adjuntos",
            "attachments": [
                {"filename": "blob.bin",
                 "content_type": "application/octet-stream",
                 "content_b64": base64.b64encode(raw_bin).decode()},
                {"filename": "nota.txt",
                 "content_type": "text/plain",
                 "content_b64": base64.b64encode(txt.encode("utf-8")).decode()},
            ],
        },
    )
    assert r.status_code == 200, r.text

    inbox = client.get(
        "/v1/inbox/pepper",
        headers={"X-API-Key": pepper["api_key"]},
    ).json()
    assert len(inbox) == 1
    msg = inbox[0]
    assert msg["message"] == "con dos adjuntos"
    assert msg["attachments"] is not None and len(msg["attachments"]) == 2

    a0, a1 = msg["attachments"]
    assert a0["filename"] == "blob.bin"
    assert a0["content_type"] == "application/octet-stream"
    got_bin = base64.b64decode(a0["content_b64"])
    assert got_bin == raw_bin
    assert hashlib.sha256(got_bin).hexdigest() == sha_in

    assert a1["filename"] == "nota.txt"
    assert a1["content_type"] == "text/plain"
    assert base64.b64decode(a1["content_b64"]).decode("utf-8") == txt

    threads = client.get(
        "/v1/threads",
        headers={"X-API-Key": pepper["api_key"]},
    ).json()["threads"]
    th_msg = threads[0]["messages"][0]
    assert th_msg["attachments"] is not None
    assert len(th_msg["attachments"]) == 2
    assert base64.b64decode(th_msg["attachments"][0]["content_b64"]) == raw_bin


def test_attachments_optional_field_stays_null(client):
    """Mensajes sin attachments deben surface como `attachments: null`."""
    rocky = register_agent(client, "rocky")
    pepper = register_agent(client, "pepper")
    client.post(
        "/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "rocky", "to_agent": "pepper", "message": "sin adjuntos"},
    )
    inbox = client.get(
        "/v1/inbox/pepper",
        headers={"X-API-Key": pepper["api_key"]},
    ).json()
    assert inbox[0]["attachments"] is None


def test_attachments_too_many_rejected(client):
    rocky = register_agent(client, "rocky")
    register_agent(client, "pepper")
    one = {"filename": "x.txt", "content_type": "text/plain",
           "content_b64": base64.b64encode(b"hi").decode()}
    r = client.post(
        "/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "rocky", "to_agent": "pepper",
              "message": "demasiados", "attachments": [one] * 6},
    )
    assert r.status_code == 413
    assert "Max" in r.json()["detail"]


def test_attachments_too_large_rejected(client):
    rocky = register_agent(client, "rocky")
    register_agent(client, "pepper")
    big = b"A" * (512 * 1024 + 64)  # > 512 KB raw
    r = client.post(
        "/v1/send",
        headers={"X-API-Key": rocky["api_key"]},
        json={"from_agent": "rocky", "to_agent": "pepper",
              "message": "muy pesado",
              "attachments": [{"filename": "big.bin",
                               "content_type": "application/octet-stream",
                               "content_b64": base64.b64encode(big).decode()}]},
    )
    assert r.status_code == 413
    assert "exceeds" in r.json()["detail"]


# ---------- owner identity ----------

def test_register_with_owner_persists(client):
    r = client.post(
        "/v1/agents/register",
        json={
            "agent_id": "antony-bot",
            "display_name": "Antony Bot",
            "platform": "Telegram",
            "owner_first_name": "Antony",
            "owner_last_name": "Pérez",
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["owner_first_name"] == "Antony"
    assert body["owner_last_name"] == "Pérez"

    # Owner appears in /v1/me and /v1/agents (no key needed for the listing)
    me = client.get("/v1/me", headers={"X-API-Key": body["api_key"]}).json()
    assert me["owner_first_name"] == "Antony"
    assert me["owner_last_name"] == "Pérez"
    listing = client.get("/v1/agents").json()
    found = next(a for a in listing if a["agent_id"] == "antony-bot")
    assert found["owner_first_name"] == "Antony"
    assert found["owner_last_name"] == "Pérez"


def test_register_without_owner_defaults_null(client):
    rocky = register_agent(client, "rocky")
    me = client.get("/v1/me", headers={"X-API-Key": rocky["api_key"]}).json()
    assert me["owner_first_name"] is None
    assert me["owner_last_name"] is None


def test_self_service_owner_update(client):
    """An agent can set/update its own owner using its own API key."""
    rocky = register_agent(client, "rocky")
    headers = {"X-API-Key": rocky["api_key"]}

    r = client.patch(
        "/v1/me/owner",
        headers=headers,
        json={"owner_first_name": "Antony", "owner_last_name": "Pérez"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["owner_first_name"] == "Antony"
    assert body["owner_last_name"] == "Pérez"

    # Persists in /v1/me and /v1/agents
    me = client.get("/v1/me", headers=headers).json()
    assert me["owner_first_name"] == "Antony"
    assert me["owner_last_name"] == "Pérez"


def test_self_service_owner_partial_update(client):
    rocky = register_agent(client, "rocky")
    headers = {"X-API-Key": rocky["api_key"]}
    client.patch("/v1/me/owner", headers=headers,
        json={"owner_first_name": "Antony", "owner_last_name": "Pérez"})

    # Only update last name; first name must persist
    r = client.patch("/v1/me/owner", headers=headers,
        json={"owner_last_name": "Suárez"})
    assert r.status_code == 200
    body = r.json()
    assert body["owner_first_name"] == "Antony"
    assert body["owner_last_name"] == "Suárez"


def test_self_service_owner_clear(client):
    rocky = register_agent(client, "rocky")
    headers = {"X-API-Key": rocky["api_key"]}
    client.patch("/v1/me/owner", headers=headers,
        json={"owner_first_name": "Antony", "owner_last_name": "Pérez"})

    r = client.patch("/v1/me/owner", headers=headers, json={"clear": True})
    assert r.status_code == 200
    body = r.json()
    assert body["owner_first_name"] is None
    assert body["owner_last_name"] is None


def test_self_service_owner_empty_payload_rejected(client):
    rocky = register_agent(client, "rocky")
    r = client.patch("/v1/me/owner",
        headers={"X-API-Key": rocky["api_key"]}, json={})
    assert r.status_code == 400


def test_self_service_owner_requires_auth(client):
    register_agent(client, "rocky")
    r = client.patch("/v1/me/owner", json={"owner_first_name": "X"})
    assert r.status_code == 422  # missing X-API-Key header


def test_self_service_owner_isolated_per_agent(client):
    rocky = register_agent(client, "rocky")
    pepper = register_agent(client, "pepper")
    client.patch("/v1/me/owner",
        headers={"X-API-Key": rocky["api_key"]},
        json={"owner_first_name": "Antony", "owner_last_name": "Pérez"})
    # Pepper unaffected
    me = client.get("/v1/me", headers={"X-API-Key": pepper["api_key"]}).json()
    assert me["owner_first_name"] is None
    assert me["owner_last_name"] is None


def test_admin_patch_owner(monkeypatch):
    """Admin can set/update owner via PATCH /v1/agents/{id} when ADMIN_TOKEN is set."""
    import importlib, os, tempfile
    from fastapi.testclient import TestClient

    tmpdir = tempfile.mkdtemp(prefix="bridge-test-admin-")
    monkeypatch.setenv("DATABASE_URL", os.path.join(tmpdir, "bridge.db"))
    monkeypatch.setenv("REGISTRATION_TOKEN", "")
    monkeypatch.setenv("ADMIN_TOKEN", "admin-secret")
    from app import database, main
    importlib.reload(database)
    importlib.reload(main)

    with TestClient(main.app) as c:
        c.post("/v1/agents/register",
            json={"agent_id": "rocky", "display_name": "Rocky"})
        r = c.patch(
            "/v1/agents/rocky",
            headers={"X-Admin-Token": "admin-secret"},
            json={"owner_first_name": "Diego", "owner_last_name": "Suárez"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["owner_first_name"] == "Diego"
        assert body["owner_last_name"] == "Suárez"


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
