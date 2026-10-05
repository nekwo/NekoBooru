"""Application update endpoints."""
import asyncio
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..dependencies import get_current_user
from ..models import User
from ..services import update_service

router = APIRouter(prefix="/api/updates", tags=["updates"])


class UpdateSettingsRequest(BaseModel):
    owner: str = update_service.DEFAULT_OWNER
    repo: str = update_service.DEFAULT_REPO
    channel: str = "stable"
    autoCheck: bool = True
    autoDownload: bool = False
    includePrereleases: bool = False


@router.get("/status")
async def get_update_status(auto: bool = False, current_user: User = Depends(get_current_user)):
    # An auto check calls GitHub (up to 12 s); keep it off the event loop.
    return await asyncio.to_thread(update_service.status, auto_check=auto)


@router.put("/settings")
async def put_update_settings(request: UpdateSettingsRequest, current_user: User = Depends(get_current_user)):
    return update_service.save_settings(request.model_dump())


@router.post("/check")
async def check_updates(current_user: User = Depends(get_current_user)):
    return await asyncio.to_thread(update_service.check_now)
