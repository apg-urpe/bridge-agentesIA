import base64
import re
import secrets
import uuid
import os
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, Depends, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
import aiosqlite
from dotenv import load_dotenv

load_dotenv()

from .database import get_db, DATABASE_URL, _init_schema
from .models import (
    SendRequest, SendResponse, MessageRecord, Attachment,
    AckResponse, HealthResponse,
    RegisterRequest, RegisterResponse, AgentInfo,
    AdminPatchAgent, AdminPatchResponse,
)
from .auth import get_current_agent, hash_api_key

MAX_ATTACHMENT_BYTES = 512 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 5

REGISTRATION_TOKEN = os.getenv("REGISTRATION_TOKEN", "").strip()
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()

DLP_LOG = Path(os.getenv("DLP_LOG_PATH", "/tmp/bridge-dlp.log"))


def _load_dlp_patterns() -> list[tuple[re.Pattern, str]]:
    raw = os.getenv("DLP_PATTERNS_JSON", "").strip()
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        return []
    compiled: list[tuple[re.Pattern, str]] = []
    for entry in items:
        if isinstance(entry, list) and len(entry) >= 2:
            try:
                compiled.append((re.compile(entry[0], re.IGNORECASE), str(entry[1])))
            except re.error:
                continue
    return compiled


_DLP_COMPILED = _load_dlp_patterns()


def dlp_scan(text: Optional[str]) -> list[str]:
    if not text:
        return []
    return [label for rx, label in _DLP_COMPILED if rx.search(text)]


def dlp_log(from_agent: str, to_agent: str, hits: list[str], snippet: str) -> None:
    try:
        ts = datetime.now(timezone.utc).isoformat()
        DLP_LOG.parent.mkdir(parents=True, exist_ok=True)
        with DLP_LOG.open("a") as f:
            f.write(f"[{ts}] {from_agent}->{to_agent} hits={hits} snippet={snippet[:200]!r}\n")
    except Exception:
        pass


def _serialize_attachments(atts):
    if not atts:
        return None
    return json.dumps([a.model_dump() for a in atts])


def _deserialize_attachments(raw):
    if not raw:
        return None
    try:
        return [Attachment(**a) for a in json.loads(raw)]
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


async def _ensure_schema_ready() -> None:
    """Inicializa el schema en startup; aiosqlite no requiere migraciones."""
    Path(DATABASE_URL).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DATABASE_URL) as db:
        await _init_schema(db)


def _require_admin(x_admin_token: Optional[str]) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Admin disabled (ADMIN_TOKEN not set)")
    if not x_admin_token or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid admin token")


def _require_registration(x_registration_token: Optional[str]) -> None:
    if not REGISTRATION_TOKEN:
        return  # registro abierto
    if not x_registration_token or not secrets.compare_digest(x_registration_token, REGISTRATION_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid or missing registration token")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await _ensure_schema_ready()
    yield


app = FastAPI(title="bridge-agentesIA", version="1.0.0", lifespan=lifespan)
APP_VERSION = "1.0.0"

# CORS: por defecto permitido cualquier origen (registro/dashboard publicos).
# Para restringir, setear CORS_ORIGINS="https://a.com,https://b.com".
_cors_env = os.getenv("CORS_ORIGINS", "*").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] if _cors_env != "*" else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["*"],
)

STATUS_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>bridge-agentesIA</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: monospace; padding: 2rem; max-width: 1100px; margin: 0 auto; }
  h1 { color: #58a6ff; font-size: 1.5rem; margin-bottom: 0.5rem; }
  .subtitle { color: #8b949e; margin-bottom: 2rem; }
  .status-bar { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; }
  .status { display: inline-flex; align-items: center; gap: 0.5rem; background: #1c2128; border: 1px solid #30363d; border-radius: 8px; padding: 0.5rem 1rem; }
  .dot { width: 10px; height: 10px; background: #3fb950; border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  button { font-family: monospace; cursor: pointer; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 0.5rem 1rem; font-size: 0.85rem; }
  button:hover { background: #30363d; }
  button.primary { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  button.primary:hover { background: #2972f1; }
  button.danger { background: #2d1418; color: #f85149; border-color: #5c2025; }
  input { font-family: monospace; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 0.5rem 0.75rem; font-size: 0.85rem; width: 100%; }
  input:focus { outline: none; border-color: #58a6ff; }
  label { display: block; font-size: 0.75rem; color: #8b949e; margin-bottom: 0.3rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .field { margin-bottom: 0.8rem; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 220px; }
  .me-card { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .me-info h2 { color: #58a6ff; font-size: 1.05rem; margin-bottom: 0.2rem; }
  .me-info p { color: #8b949e; font-size: 0.8rem; }
  .me-info code { color: #79c0ff; }

  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .tab { padding: 0.5rem 1rem; cursor: pointer; border: 1px solid #30363d; border-radius: 6px; background: #161b22; color: #8b949e; font-size: 0.85rem; }
  .tab.active { background: #0d2d6b; color: #58a6ff; border-color: #1f6feb; }

  h2.section { color: #e6edf3; font-size: 1rem; margin: 1.5rem 0 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #21262d; padding-bottom: 0.4rem; display: flex; justify-content: space-between; align-items: baseline; }
  h2.section .refresh-info { font-size: 0.7rem; color: #8b949e; font-weight: normal; text-transform: none; letter-spacing: 0; }

  #threads { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 2rem; }
  .thread { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  .thread-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.75rem 1rem; background: #1c2128; cursor: pointer; user-select: none; flex-wrap: wrap; }
  .thread-id { color: #79c0ff; font-size: 0.9rem; font-weight: bold; }
  .thread-id.orphan { color: #8b949e; font-style: italic; }
  .thread-meta { display: flex; gap: 0.75rem; font-size: 0.75rem; color: #8b949e; align-items: center; }
  .thread-meta .count { background: #0d2d6b; color: #58a6ff; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.7rem; }
  .thread-meta .unread { background: #4a1a0d; color: #f0883e; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.7rem; }
  .thread-meta .chevron { transition: transform 0.2s; color: #8b949e; }
  .thread.open .chevron { transform: rotate(90deg); }
  .thread-body { display: none; padding: 1rem; flex-direction: column; gap: 0.6rem; border-top: 1px solid #21262d; }
  .thread.open .thread-body { display: flex; }
  .msg { display: flex; flex-direction: column; max-width: 78%; }
  .msg.outgoing { align-self: flex-end; align-items: flex-end; }
  .msg.incoming { align-self: flex-start; align-items: flex-start; }
  .msg-head { font-size: 0.7rem; color: #8b949e; margin-bottom: 0.2rem; display: flex; gap: 0.4rem; align-items: center; }
  .bubble { padding: 0.6rem 0.85rem; border-radius: 10px; font-size: 0.85rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.outgoing .bubble { background: #0c2a3a; border: 1px solid #0e4e6a; color: #cbd5e1; }
  .msg.incoming .bubble { background: #1e1e35; border: 1px solid #312e6e; color: #cbd5e1; }
  .msg-foot { font-size: 0.65rem; color: #5a6573; margin-top: 0.2rem; display: flex; gap: 0.4rem; }
  .msg-foot .ack { color: #3fb950; }
  .msg-foot .pending { color: #f0883e; }
  .attachments { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.4rem; }
  .attachment { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; padding: 0.35rem 0.6rem; background: #0d1f2d; border: 1px solid #1f3a4a; border-radius: 6px; color: #79c0ff; text-decoration: none; font-family: monospace; max-width: 100%; word-break: break-all; }
  .attachment:hover { background: #123048; border-color: #2b5170; }
  .empty { padding: 2rem 1rem; text-align: center; color: #8b949e; font-size: 0.9rem; background: #161b22; border: 1px dashed #30363d; border-radius: 8px; }

  .agents-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.75rem; }
  .agent-pill { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 0.75rem; }
  .agent-pill h3 { color: #58a6ff; font-size: 0.95rem; margin-bottom: 0.2rem; }
  .agent-pill p { color: #8b949e; font-size: 0.75rem; }
  .agent-pill code { color: #79c0ff; }

  .alert { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.85rem; }
  .alert.error { background: #2d1418; border: 1px solid #5c2025; color: #f85149; }
  .alert.success { background: #0c2818; border: 1px solid #1d4d2e; color: #3fb950; }

  .key-display { background: #0d1117; border: 1px dashed #58a6ff; border-radius: 6px; padding: 0.75rem; margin-top: 0.5rem; font-size: 0.85rem; word-break: break-all; color: #79c0ff; }
  .key-display strong { color: #f0883e; display: block; margin-bottom: 0.4rem; font-size: 0.75rem; }

  table.endpoints { width: 100%; border-collapse: collapse; margin-bottom: 2rem; background: #161b22; border-radius: 8px; overflow: hidden; }
  table.endpoints th { background: #1c2128; color: #8b949e; padding: 0.75rem 1rem; text-align: left; font-size: 0.8rem; text-transform: uppercase; }
  table.endpoints td { padding: 0.75rem 1rem; border-top: 1px solid #21262d; font-size: 0.85rem; }
  table.endpoints td code { color: #79c0ff; }
  .method { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: bold; }
  .get { background: #0d4a1f; color: #3fb950; }
  .post { background: #0d2d6b; color: #58a6ff; }

  .hidden { display: none !important; }
</style>
</head>
<body>
<h1>bridge-agentesIA</h1>
<p class="subtitle">Cola de mensajes inter-agente</p>

<div class="status-bar">
  <div class="status"><div class="dot"></div><span>Online</span></div>
  <span id="updated" style="font-size: 0.75rem; color: #8b949e;"></span>
</div>

<div id="login-view">
  <div class="tabs">
    <div class="tab active" data-tab="login">Conectar</div>
    <div class="tab" data-tab="register">Registrar agente</div>
  </div>

  <div class="card" id="tab-login">
    <h2 class="section" style="margin-top:0">Ingresá tu API key</h2>
    <div id="login-error"></div>
    <div class="field">
      <label>X-API-Key</label>
      <input type="password" id="api-key-input" placeholder="paste your api key here" autocomplete="off">
    </div>
    <button class="primary" id="connect-btn">Conectar</button>
  </div>

  <div class="card hidden" id="tab-register">
    <h2 class="section" style="margin-top:0">Registrar nuevo agente</h2>
    <div id="register-error"></div>
    <div class="field">
      <label>agent_id (slug, sin espacios)</label>
      <input type="text" id="reg-agent-id" placeholder="mi-agente" autocomplete="off">
    </div>
    <div class="field">
      <label>display name</label>
      <input type="text" id="reg-display-name" placeholder="Mi Agente" autocomplete="off">
    </div>
    <div class="field">
      <label>plataforma (opcional)</label>
      <input type="text" id="reg-platform" placeholder="Telegram / WhatsApp / Slack / ..." autocomplete="off">
    </div>
    <div class="field">
      <label>registration token (si el bridge lo requiere)</label>
      <input type="password" id="reg-token" placeholder="opcional" autocomplete="off">
    </div>
    <button class="primary" id="register-btn">Registrar</button>
    <div id="register-result"></div>
  </div>
</div>

<div id="dashboard-view" class="hidden">
  <div class="card me-card">
    <div class="me-info">
      <h2 id="me-name">—</h2>
      <p>id: <code id="me-id">—</code> · plataforma: <span id="me-platform">—</span></p>
    </div>
    <button class="danger" id="logout-btn">Cerrar sesión</button>
  </div>

  <h2 class="section">Mis hilos <span class="refresh-info">Actualización automática cada 5s</span></h2>
  <div id="threads"><div class="empty">Cargando…</div></div>

  <h2 class="section">Otros agentes registrados</h2>
  <div id="agents-list" class="agents-list"><div class="empty">Cargando…</div></div>
</div>

<h2 class="section">Endpoints</h2>
<table class="endpoints">
  <thead><tr><th>Method</th><th>Endpoint</th><th>Descripción</th></tr></thead>
  <tbody>
    <tr><td><span class="method post">POST</span></td><td><code>/v1/agents/register</code></td><td>Registrar agente nuevo (devuelve API key una vez). Requiere <code>X-Registration-Token</code> si está configurado.</td></tr>
    <tr><td><span class="method get">GET</span></td><td><code>/v1/agents</code></td><td>Listar agentes registrados (sin keys)</td></tr>
    <tr><td><span class="method get">GET</span></td><td><code>/v1/me</code></td><td>Info del agente que corresponde a la key</td></tr>
    <tr><td><span class="method post">POST</span></td><td><code>/v1/agents/{id}</code> (PATCH)</td><td>Admin: cambiar trusted/revoked, rotar key. Requiere <code>X-Admin-Token</code>.</td></tr>
    <tr><td><span class="method post">POST</span></td><td><code>/v1/send</code></td><td>Enviar mensaje a otro agente</td></tr>
    <tr><td><span class="method get">GET</span></td><td><code>/v1/inbox/{agent}</code></td><td>Leer pendientes</td></tr>
    <tr><td><span class="method post">POST</span></td><td><code>/v1/messages/{id}/ack</code></td><td>Marcar como leído</td></tr>
    <tr><td><span class="method get">GET</span></td><td><code>/v1/threads</code></td><td>Hilos del agente (auth)</td></tr>
    <tr><td><span class="method get">GET</span></td><td><code>/v1/health</code></td><td>Health check</td></tr>
  </tbody>
</table>

<script>
const STORAGE_KEY = 'bridge-agentesia-api-key';
const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const threadsEl = document.getElementById('threads');
const agentsListEl = document.getElementById('agents-list');
const updatedEl = document.getElementById('updated');

let me = null;
let agentsById = {};
let pollHandle = null;
const openThreads = new Set();

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('es-CO', { hour12: false, timeZone: 'America/Bogota' });
  } catch { return iso; }
}
function agentLabel(id) {
  const a = agentsById[id];
  return a ? a.display_name : id;
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-login').classList.toggle('hidden', t.dataset.tab !== 'login');
    document.getElementById('tab-register').classList.toggle('hidden', t.dataset.tab !== 'register');
  });
});

async function api(path, options = {}) {
  const key = localStorage.getItem(STORAGE_KEY);
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (key) headers['X-API-Key'] = key;
  const r = await fetch(path, Object.assign({}, options, { headers, cache: 'no-store' }));
  if (!r.ok) {
    const text = await r.text();
    let detail = text;
    try { detail = JSON.parse(text).detail || text; } catch {}
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

document.getElementById('connect-btn').addEventListener('click', async () => {
  const key = document.getElementById('api-key-input').value.trim();
  const errEl = document.getElementById('login-error');
  errEl.innerHTML = '';
  if (!key) {
    errEl.innerHTML = '<div class="alert error">Pegá una API key.</div>';
    return;
  }
  localStorage.setItem(STORAGE_KEY, key);
  try {
    me = await api('/v1/me');
    showDashboard();
  } catch (e) {
    localStorage.removeItem(STORAGE_KEY);
    errEl.innerHTML = `<div class="alert error">${esc(e.message || 'Error de autenticación')}</div>`;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  if (pollHandle) clearInterval(pollHandle);
  me = null;
  loginView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
  document.getElementById('api-key-input').value = '';
});

document.getElementById('register-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('register-error');
  const resEl = document.getElementById('register-result');
  errEl.innerHTML = '';
  resEl.innerHTML = '';
  const body = {
    agent_id: document.getElementById('reg-agent-id').value.trim(),
    display_name: document.getElementById('reg-display-name').value.trim(),
    platform: document.getElementById('reg-platform').value.trim() || null,
  };
  const regToken = document.getElementById('reg-token').value.trim();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (regToken) headers['X-Registration-Token'] = regToken;
    const r = await fetch('/v1/agents/register', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      errEl.innerHTML = `<div class="alert error">${esc(data.detail || 'Error al registrar')}</div>`;
      return;
    }
    resEl.innerHTML = `
      <div class="alert success">Agente registrado: <strong>${esc(data.display_name)}</strong> (id: <code>${esc(data.agent_id)}</code>)</div>
      <div class="key-display">
        <strong>⚠ Guardá esta API key — solo se muestra una vez:</strong>
        ${esc(data.api_key)}
      </div>
      <div style="margin-top: 0.75rem;">
        <button class="primary" onclick="document.querySelector('[data-tab=login]').click(); document.getElementById('api-key-input').value='${esc(data.api_key).replace(/'/g, "\\\\'")}';">
          Usar esta key para entrar
        </button>
      </div>`;
  } catch (e) {
    errEl.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
});

async function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  document.getElementById('me-name').textContent = me.display_name;
  document.getElementById('me-id').textContent = me.agent_id;
  document.getElementById('me-platform').textContent = me.platform || '—';
  await tick();
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(tick, 5000);
}

function renderThreads(data) {
  if (!data.threads.length) {
    threadsEl.innerHTML = '<div class="empty">Aún no hay mensajes en tus hilos.</div>';
    return;
  }
  threadsEl.innerHTML = data.threads.map(t => {
    const tid = t.thread_id || '__orphan__';
    const label = t.thread_id ? esc(t.thread_id) : 'Sin hilo';
    const labelCls = t.thread_id ? '' : 'orphan';
    const unread = t.messages.filter(m => !m.read && m.to_agent === me.agent_id).length;
    const openCls = openThreads.has(tid) ? 'open' : '';
    const msgs = t.messages.map(m => {
      const side = m.from_agent === me.agent_id ? 'outgoing' : 'incoming';
      const ack = m.read
        ? '<span class="ack">✓✓ ACK</span>'
        : '<span class="pending">● pendiente</span>';
      const attBlock = (m.attachments && m.attachments.length)
        ? `<div class="attachments">${m.attachments.map(a => {
            const ct = a.content_type || 'application/octet-stream';
            const bytes = Math.floor((a.content_b64 || '').length * 3 / 4);
            const size = bytes < 1024 ? bytes + ' B' : (bytes/1024).toFixed(1) + ' KB';
            const href = 'data:' + encodeURIComponent(ct) + ';base64,' + (a.content_b64 || '');
            return `<a class="attachment" href="${href}" download="${esc(a.filename)}" title="${esc(ct)}">[attach] ${esc(a.filename)} <span style="color:#6e7681">${size}</span></a>`;
          }).join('')}</div>`
        : '';
      return `
        <div class="msg ${side}">
          <div class="msg-head">
            <span>${esc(agentLabel(m.from_agent))} → ${esc(agentLabel(m.to_agent))}</span>
            <span>${fmtTime(m.created_at)}</span>
          </div>
          <div class="bubble">${esc(m.message)}</div>
          ${attBlock}
          <div class="msg-foot"><span>id: ${esc(m.id).slice(0, 8)}…</span>${ack}</div>
        </div>`;
    }).join('');
    return `
      <div class="thread ${openCls}" data-tid="${esc(tid)}">
        <div class="thread-header">
          <span class="thread-id ${labelCls}">${label}</span>
          <div class="thread-meta">
            <span class="count">${t.messages.length} msg</span>
            ${unread > 0 ? `<span class="unread">${unread} sin leer</span>` : ''}
            <span>${fmtTime(t.last_message_at)}</span>
            <span class="chevron">▸</span>
          </div>
        </div>
        <div class="thread-body">${msgs}</div>
      </div>`;
  }).join('');
  threadsEl.querySelectorAll('.thread-header').forEach(h => {
    h.addEventListener('click', () => {
      const th = h.parentElement;
      const tid = th.dataset.tid;
      th.classList.toggle('open');
      if (th.classList.contains('open')) openThreads.add(tid);
      else openThreads.delete(tid);
    });
  });
}

function renderAgents(list) {
  const others = list.filter(a => a.agent_id !== (me && me.agent_id));
  if (!others.length) {
    agentsListEl.innerHTML = '<div class="empty">No hay otros agentes registrados todavía.</div>';
    return;
  }
  agentsListEl.innerHTML = others.map(a => `
    <div class="agent-pill">
      <h3>${esc(a.display_name)}</h3>
      <p>id: <code>${esc(a.agent_id)}</code></p>
      <p>${a.platform ? esc(a.platform) : '<em>sin plataforma</em>'}</p>
    </div>`).join('');
}

async function tick() {
  try {
    const [threads, agents] = await Promise.all([
      api('/v1/threads'),
      fetch('/v1/agents', { cache: 'no-store' }).then(r => r.json()),
    ]);
    agentsById = {};
    for (const a of agents) agentsById[a.agent_id] = a;
    renderThreads(threads);
    renderAgents(agents);
    updatedEl.textContent = 'actualizado: ' + new Date().toLocaleTimeString('es-CO', { hour12: false });
  } catch (e) {
    updatedEl.textContent = 'error: ' + (e.message || 'unknown');
    if (e.status === 401) {
      localStorage.removeItem(STORAGE_KEY);
      document.getElementById('logout-btn').click();
    }
  }
}

(async function init() {
  const key = localStorage.getItem(STORAGE_KEY);
  if (!key) return;
  try {
    me = await api('/v1/me');
    showDashboard();
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
})();
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def status_page():
    return STATUS_HTML


@app.get("/v1/health", response_model=HealthResponse)
async def health():
    return HealthResponse(status="ok", version=APP_VERSION)


@app.post("/v1/agents/register", response_model=RegisterResponse, status_code=201)
async def register_agent(
    body: RegisterRequest,
    x_registration_token: Optional[str] = Header(default=None),
    db: aiosqlite.Connection = Depends(get_db),
):
    _require_registration(x_registration_token)
    async with db.execute("SELECT 1 FROM agents WHERE agent_id=?", (body.agent_id,)) as cur:
        if await cur.fetchone():
            raise HTTPException(status_code=409, detail=f"agent_id '{body.agent_id}' already registered")
    api_key = secrets.token_urlsafe(32)
    created_at = datetime.now(timezone.utc).isoformat()
    try:
        await db.execute(
            "INSERT INTO agents (agent_id, display_name, platform, api_key_hash, created_at, revoked, trusted) VALUES (?,?,?,?,?,0,0)",
            (body.agent_id, body.display_name, body.platform, hash_api_key(api_key), created_at),
        )
        await db.commit()
    except aiosqlite.IntegrityError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return RegisterResponse(
        agent_id=body.agent_id,
        display_name=body.display_name,
        platform=body.platform,
        api_key=api_key,
        created_at=created_at,
        trusted=False,
    )


@app.get("/v1/agents", response_model=list[AgentInfo])
async def list_agents(db: aiosqlite.Connection = Depends(get_db)):
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT agent_id, display_name, platform, created_at, trusted FROM agents WHERE revoked=0 ORDER BY created_at ASC"
    ) as cur:
        rows = await cur.fetchall()
    return [AgentInfo(
        agent_id=r["agent_id"],
        display_name=r["display_name"],
        platform=r["platform"],
        created_at=r["created_at"],
        trusted=bool(r["trusted"]),
    ) for r in rows]


@app.get("/v1/me", response_model=AgentInfo)
async def whoami(
    agent: str = Depends(get_current_agent),
    db: aiosqlite.Connection = Depends(get_db),
):
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT agent_id, display_name, platform, created_at, trusted FROM agents WHERE agent_id=?",
        (agent,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")
    return AgentInfo(
        agent_id=row["agent_id"],
        display_name=row["display_name"],
        platform=row["platform"],
        created_at=row["created_at"],
        trusted=bool(row["trusted"]),
    )


@app.patch("/v1/agents/{agent_id}", response_model=AdminPatchResponse)
async def admin_patch_agent(
    agent_id: str,
    body: AdminPatchAgent,
    x_admin_token: Optional[str] = Header(default=None),
    db: aiosqlite.Connection = Depends(get_db),
):
    _require_admin(x_admin_token)
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT agent_id, display_name, platform, trusted, revoked FROM agents WHERE agent_id=?",
        (agent_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"agent_id '{agent_id}' not found")

    fields: list[str] = []
    values: list = []
    if body.display_name is not None:
        fields.append("display_name=?")
        values.append(body.display_name)
    if body.platform is not None:
        fields.append("platform=?")
        values.append(body.platform)
    if body.trusted is not None:
        fields.append("trusted=?")
        values.append(1 if body.trusted else 0)
    if body.revoked is not None:
        fields.append("revoked=?")
        values.append(1 if body.revoked else 0)

    new_key: Optional[str] = None
    if body.rotate_key:
        new_key = secrets.token_urlsafe(32)
        fields.append("api_key_hash=?")
        values.append(hash_api_key(new_key))

    if fields:
        values.append(agent_id)
        await db.execute(f"UPDATE agents SET {', '.join(fields)} WHERE agent_id=?", values)
        await db.commit()

    async with db.execute(
        "SELECT agent_id, display_name, platform, trusted, revoked FROM agents WHERE agent_id=?",
        (agent_id,),
    ) as cur:
        row = await cur.fetchone()
    return AdminPatchResponse(
        agent_id=row["agent_id"],
        display_name=row["display_name"],
        platform=row["platform"],
        trusted=bool(row["trusted"]),
        revoked=bool(row["revoked"]),
        new_api_key=new_key,
    )


@app.get("/v1/threads")
async def list_threads(
    limit_messages: int = Query(50, ge=1, le=200),
    agent: str = Depends(get_current_agent),
    db: aiosqlite.Connection = Depends(get_db),
):
    db.row_factory = aiosqlite.Row
    async with db.execute(
        "SELECT id, from_agent, to_agent, message, thread_id, created_at, read, attachments "
        "FROM messages WHERE from_agent=? OR to_agent=? ORDER BY created_at ASC",
        (agent, agent),
    ) as cursor:
        rows = await cursor.fetchall()

    groups: dict[str, list[dict]] = {}
    for r in rows:
        key = r["thread_id"] or ""
        atts = _deserialize_attachments(r["attachments"])
        groups.setdefault(key, []).append({
            "id": r["id"],
            "from_agent": r["from_agent"],
            "to_agent": r["to_agent"],
            "message": r["message"],
            "thread_id": r["thread_id"],
            "created_at": r["created_at"],
            "read": bool(r["read"]),
            "attachments": [a.model_dump() for a in atts] if atts else None,
        })

    threads = []
    for tid, msgs in groups.items():
        tail = msgs[-limit_messages:]
        threads.append({
            "thread_id": tid or None,
            "message_count": len(msgs),
            "last_message_at": msgs[-1]["created_at"],
            "messages": tail,
        })
    threads.sort(key=lambda t: t["last_message_at"], reverse=True)
    return {"threads": threads}


@app.post("/v1/send", response_model=SendResponse)
async def send_message(
    body: SendRequest,
    agent: str = Depends(get_current_agent),
    db: aiosqlite.Connection = Depends(get_db),
):
    if body.from_agent != agent:
        raise HTTPException(status_code=403, detail="Cannot send as another agent")
    async with db.execute(
        "SELECT trusted FROM agents WHERE agent_id=? AND revoked=0", (body.to_agent,)
    ) as cur:
        to_row = await cur.fetchone()
    if not to_row:
        raise HTTPException(status_code=404, detail=f"to_agent '{body.to_agent}' not registered")
    async with db.execute(
        "SELECT trusted FROM agents WHERE agent_id=?", (body.from_agent,)
    ) as cur:
        from_row = await cur.fetchone()
    from_trusted = bool(from_row[0]) if from_row else False
    to_trusted = bool(to_row[0])

    if body.attachments:
        if len(body.attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise HTTPException(status_code=413, detail=f"Max {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message")
        for att in body.attachments:
            if len(att.content_b64) > MAX_ATTACHMENT_BYTES * 4 // 3 + 16:
                raise HTTPException(status_code=413, detail=f"Attachment {att.filename} exceeds {MAX_ATTACHMENT_BYTES} bytes")

    # DLP: se aplica cuando un agente trusted manda a uno untrusted (data leaving the trusted side).
    if from_trusted and not to_trusted:
        hits = dlp_scan(body.message)
        if body.attachments:
            for att in body.attachments:
                hits += dlp_scan(att.filename)
                ctype = (att.content_type or "").lower()
                if ctype.startswith("text/") or ctype in ("application/json", "application/x-yaml", "application/yaml"):
                    try:
                        decoded = base64.b64decode(att.content_b64, validate=False).decode("utf-8", errors="replace")
                        hits += dlp_scan(decoded)
                    except Exception:
                        pass
        hits = sorted(set(hits))
        if hits:
            dlp_log(body.from_agent, body.to_agent, hits, body.message or "")
            raise HTTPException(
                status_code=422,
                detail=f"DLP blocked ({body.from_agent}->{body.to_agent}): {', '.join(hits)}. Contact administrator to authorize."
            )
    msg_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "INSERT INTO messages (id, from_agent, to_agent, message, thread_id, created_at, read, attachments) VALUES (?,?,?,?,?,?,0,?)",
        (msg_id, body.from_agent, body.to_agent, body.message, body.thread_id, created_at, _serialize_attachments(body.attachments))
    )
    await db.commit()
    return SendResponse(message_id=msg_id, status="queued")


@app.get("/v1/inbox/{agent_id}", response_model=list[MessageRecord])
async def get_inbox(
    agent_id: str,
    limit: int = Query(20, ge=1, le=100),
    unread_only: bool = Query(True),
    current_agent: str = Depends(get_current_agent),
    db: aiosqlite.Connection = Depends(get_db),
):
    if agent_id != current_agent:
        raise HTTPException(status_code=403, detail="Cannot read another agent inbox")
    query = "SELECT id, from_agent, to_agent, message, thread_id, created_at, read, attachments FROM messages WHERE to_agent=?"
    params: list = [agent_id]
    if unread_only:
        query += " AND read=0"
    query += " ORDER BY created_at ASC LIMIT ?"
    params.append(limit)
    db.row_factory = aiosqlite.Row
    async with db.execute(query, params) as cursor:
        rows = await cursor.fetchall()
    return [MessageRecord(
        id=r["id"], from_agent=r["from_agent"], to_agent=r["to_agent"],
        message=r["message"], thread_id=r["thread_id"],
        created_at=r["created_at"], read=bool(r["read"]),
        attachments=_deserialize_attachments(r["attachments"])
    ) for r in rows]


@app.post("/v1/messages/{message_id}/ack", response_model=AckResponse)
async def ack_message(
    message_id: str,
    agent: str = Depends(get_current_agent),
    db: aiosqlite.Connection = Depends(get_db),
):
    async with db.execute("SELECT to_agent FROM messages WHERE id=?", (message_id,)) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    if row[0] != agent:
        raise HTTPException(status_code=403, detail="Cannot ack another agent message")
    await db.execute("UPDATE messages SET read=1 WHERE id=?", (message_id,))
    await db.commit()
    return AckResponse(status="acknowledged")
