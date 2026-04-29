import aiosqlite
import os
from pathlib import Path

DATABASE_URL = os.getenv("DATABASE_URL", "./data/bridge.db")

async def _init_schema(db: aiosqlite.Connection) -> None:
    await db.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            from_agent TEXT NOT NULL,
            to_agent TEXT NOT NULL,
            message TEXT NOT NULL,
            thread_id TEXT,
            created_at TEXT NOT NULL,
            read INTEGER NOT NULL DEFAULT 0,
            attachments TEXT
        )
    """)
    try:
        await db.execute("ALTER TABLE messages ADD COLUMN attachments TEXT")
    except aiosqlite.OperationalError:
        pass
    await db.execute("""
        CREATE TABLE IF NOT EXISTS agents (
            agent_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            platform TEXT,
            api_key_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0,
            trusted INTEGER NOT NULL DEFAULT 0
        )
    """)
    try:
        await db.execute("ALTER TABLE agents ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0")
    except aiosqlite.OperationalError:
        pass
    # Self-service appearance: each agent can override the office's hash-derived
    # palette and hue tint via PATCH /v1/me/appearance. NULL means "use default".
    for col_def in ("palette INTEGER", "hue_shift INTEGER"):
        try:
            await db.execute(f"ALTER TABLE agents ADD COLUMN {col_def}")
        except aiosqlite.OperationalError:
            pass
    await db.execute("CREATE INDEX IF NOT EXISTS idx_agents_key_hash ON agents(api_key_hash)")
    await db.commit()


async def get_db():
    Path(DATABASE_URL).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DATABASE_URL) as db:
        await _init_schema(db)
        yield db
