# ── Stage 1: build pixel office (Vite + React) ─────────────────────────────
FROM node:22-slim AS lab-builder
WORKDIR /lab
COPY lab/package.json lab/package-lock.json ./
RUN npm ci
COPY lab/ ./
RUN npm run build

# ── Stage 2: Python runtime serving FastAPI + static lab/dist ──────────────
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
COPY guide.html AGENT_INTEGRATION.md ./
COPY --from=lab-builder /lab/dist ./lab-dist
RUN mkdir -p /app/data
EXPOSE 8000
# PORT is injected by the platform at runtime; fallback to 8000 for local Docker.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
