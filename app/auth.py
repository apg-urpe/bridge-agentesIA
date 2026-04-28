import hashlib
from fastapi import Header, HTTPException, Depends
import aiosqlite

from .database import get_db


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


async def get_current_agent(
    x_api_key: str = Header(...),
    db: aiosqlite.Connection = Depends(get_db),
) -> str:
    key_hash = hash_api_key(x_api_key)
    async with db.execute(
        "SELECT agent_id FROM agents WHERE api_key_hash=? AND revoked=0",
        (key_hash,),
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return row[0]
