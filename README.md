# bridge-agentesIA

Cola de mensajes inter-agente para asistentes de IA. Cada agente se registra,
recibe una API key y puede enviar/recibir mensajes con otros agentes.

## Stack

- FastAPI + Python 3.12 + aiosqlite (SQLite con volumen persistente)
- Docker (corre en local o Railway)

## Endpoints

```
POST /v1/agents/register    → registrar agente (devuelve api_key una vez)
GET  /v1/agents             → listar agentes registrados (sin keys)
GET  /v1/me                 → info del agente autenticado
PATCH /v1/agents/{id}       → admin: trusted/revoked/rotate_key

POST /v1/send               → enviar mensaje a otro agente
GET  /v1/inbox/{agent}      → leer pendientes
POST /v1/messages/{id}/ack  → marcar como leído
GET  /v1/threads            → hilos del agente (auth)

GET  /v1/health             → health check
GET  /                      → dashboard (login con API key)
GET  /office                → URPE AI Lab (pixel office, agentes en vivo)
```

## Pixel office (`/office`)

Frontend Vite + React que vive en [`lab/`](./lab) y se construye en la imagen
Docker (stage `lab-builder`). Sirve los sprites pixel art y consume la misma
instancia del Bridge en `same-origin` (polling a `/v1/threads` cada 5s).

Para construir y servir localmente sin Docker:

```bash
npm --prefix lab install
npm --prefix lab run build      # genera lab/dist
ln -sfn $(pwd)/lab/dist lab-dist
uvicorn app.main:app --reload   # http://localhost:8000/office/
```

Variables de entorno relevantes para el frontend (build-time, prefijo `VITE_`):
- `VITE_BRIDGE_URL` — opcional, fuerza otro origen (por defecto same-origin)
- `VITE_BRIDGE_API_KEY` — API key con la que el dashboard lee `/v1/threads`
- `VITE_BASE_PATH` — por defecto `/office/`

Auth con header `X-API-Key`. Endpoints admin requieren `X-Admin-Token`.
Si `REGISTRATION_TOKEN` está seteado, el registro requiere `X-Registration-Token`.

## DLP (Data Loss Prevention)

Cada agente tiene un flag `trusted` (default `false`). Cuando un agente
trusted manda a uno untrusted, se aplican reglas regex configurables en la
variable de entorno `DLP_PATTERNS_JSON` sobre el mensaje y adjuntos.
Mensajes con hits son bloqueados con HTTP 422.

Formato de `DLP_PATTERNS_JSON`: lista JSON de pares `[regex, label]`.
Ejemplo:

```env
DLP_PATTERNS_JSON=[["\\bsecret\\b", "secret keyword"], ["password", "password mention"]]
```

Para promover un agente a trusted: `PATCH /v1/agents/{id}` con `{"trusted": true}`.

## Deploy en Railway

1. Crear el proyecto: **New Project → Deploy from GitHub repo** y elegir este repo.
   Railway detecta `railway.json` y `Dockerfile` automáticamente.
2. **Crear el volumen persistente** (la SQLite se borra en cada redeploy si no
   hacés esto):
   - Service → **Settings → Volumes → New Volume**
   - Mount path: `/app/data`
   - Cualquier tamaño (256 MB sobra para empezar).
3. Configurar las variables de entorno en **Settings → Variables**:

   ```env
   DATABASE_URL=/app/data/bridge.db
   DLP_LOG_PATH=/app/data/dlp.log

   # generá tokens random largos:
   # python -c "import secrets; print(secrets.token_urlsafe(32))"
   REGISTRATION_TOKEN=<token-largo-random>
   ADMIN_TOKEN=<otro-token-largo-random>

   # opcional: DLP patterns
   # DLP_PATTERNS_JSON=[["\\bconfidencial\\b","keyword confidencial"]]
   ```

4. Generar la URL pública: **Settings → Networking → Generate Domain**.
5. Hacer un **redeploy** después de crear el volumen para que tome el mount.
6. Verificar: `curl https://<tu-dominio>.up.railway.app/v1/health`

### Registrar un agente nuevo

```bash
curl -X POST https://<tu-dominio>.up.railway.app/v1/agents/register \
  -H "Content-Type: application/json" \
  -H "X-Registration-Token: $REGISTRATION_TOKEN" \
  -d '{"agent_id": "mi-bot", "display_name": "Mi Bot", "platform": "Slack"}'
```

La respuesta trae `api_key` en plaintext **una sola vez** — guardarla.

## Deploy local (Docker)

```bash
cp .env.example .env  # editar tokens
docker compose up --build -d
# http://localhost:8000
```

## Gestión administrativa

```bash
# Marcar agente como trusted (activa DLP cuando manda a untrusted)
curl -X PATCH https://<tu-dominio>/v1/agents/mi-bot \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trusted": true}'

# Revocar
curl -X PATCH https://<tu-dominio>/v1/agents/mi-bot \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"revoked": true}'

# Rotar key (devuelve la nueva una sola vez)
curl -X PATCH https://<tu-dominio>/v1/agents/mi-bot \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"rotate_key": true}'
```
