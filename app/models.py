from pydantic import BaseModel, Field
from typing import Optional

class Attachment(BaseModel):
    filename: str
    content_b64: str
    content_type: Optional[str] = "application/octet-stream"

class SendRequest(BaseModel):
    from_agent: str
    to_agent: str
    message: str
    thread_id: Optional[str] = None
    attachments: Optional[list[Attachment]] = None

class SendResponse(BaseModel):
    message_id: str
    status: str

class MessageRecord(BaseModel):
    id: str
    from_agent: str
    to_agent: str
    message: str
    thread_id: Optional[str]
    created_at: str
    read: bool
    attachments: Optional[list[Attachment]] = None

class AckResponse(BaseModel):
    status: str

class HealthResponse(BaseModel):
    status: str
    version: str

class RegisterRequest(BaseModel):
    agent_id: str = Field(..., min_length=2, max_length=32, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    display_name: str = Field(..., min_length=1, max_length=64)
    platform: Optional[str] = Field(None, max_length=32)
    owner_first_name: Optional[str] = Field(None, max_length=64)
    owner_last_name: Optional[str] = Field(None, max_length=64)

class RegisterResponse(BaseModel):
    agent_id: str
    display_name: str
    platform: Optional[str]
    api_key: str
    created_at: str
    trusted: bool = False
    palette: Optional[int] = None
    hue_shift: Optional[int] = None
    owner_first_name: Optional[str] = None
    owner_last_name: Optional[str] = None

class AgentInfo(BaseModel):
    agent_id: str
    display_name: str
    platform: Optional[str]
    created_at: str
    trusted: bool = False
    palette: Optional[int] = None
    hue_shift: Optional[int] = None
    owner_first_name: Optional[str] = None
    owner_last_name: Optional[str] = None

class AppearanceRequest(BaseModel):
    """Self-service appearance override. Pass null to clear and fall back to defaults."""
    palette: Optional[int] = Field(None, ge=0, le=5)
    hue_shift: Optional[int] = Field(None, ge=0, le=359)
    clear: bool = False  # if true, both fields are reset regardless of payload

class AdminPatchAgent(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=64)
    platform: Optional[str] = Field(None, max_length=32)
    trusted: Optional[bool] = None
    revoked: Optional[bool] = None
    rotate_key: Optional[bool] = None
    owner_first_name: Optional[str] = Field(None, max_length=64)
    owner_last_name: Optional[str] = Field(None, max_length=64)

class AdminPatchResponse(BaseModel):
    agent_id: str
    display_name: str
    platform: Optional[str]
    trusted: bool
    revoked: bool
    new_api_key: Optional[str] = None
    owner_first_name: Optional[str] = None
    owner_last_name: Optional[str] = None
