"""Fill in the MD5 of posts stored before posts carried one.

Boorus identify an original by its MD5, so a search result on one booru can
only be recognised as a copy imported from another once the library knows its
own files' MD5s. New posts get theirs on upload; this pass reads the older ones
in the background, one file at a time, so a library of thousands of posts does
not hold up startup or starve requests of disk.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from ..config import settings
from ..database import async_session
from ..models import Post
from ..utils.hashing import calculate_md5

logger = logging.getLogger(__name__)

BATCH = 50
# Breathing room between files; the pass is background work, not a job.
PAUSE_SECONDS = 0.01


def _md5_or_blank(path) -> str:
    try:
        return calculate_md5(path)
    except OSError:
        # Missing or unreadable: "" stops the pass re-selecting it forever.
        return ""


async def backfill_md5s() -> int:
    """Hash every live post that has no MD5 yet; returns how many were filled."""
    filled = 0
    while True:
        async with async_session() as session:
            batch = (
                await session.execute(
                    select(Post).where(Post.md5.is_(None), Post.deleted_at.is_(None)).limit(BATCH)
                )
            ).scalars().all()
            if not batch:
                break
            for post in batch:
                post.md5 = await asyncio.to_thread(_md5_or_blank, settings.posts_dir / post.content_path)
                filled += bool(post.md5)
                await asyncio.sleep(PAUSE_SECONDS)
            await session.commit()
    if filled:
        logger.info("Filled in the MD5 of %d posts", filled)
    return filled


async def run_backfill() -> None:
    try:
        await backfill_md5s()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - background courtesy; retried next start
        logger.warning("MD5 backfill stopped: %s", exc)
