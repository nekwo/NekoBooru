"""Runtime yt-dlp version and update management."""
from __future__ import annotations

import asyncio
import importlib
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from ..config import settings
from .settings import SettingsManager


VALID_POLICIES = {"manual", "startup_latest", "startup_pinned"}
# "Update on startup" checks PyPI at most this often. A pip run on every boot
# made each restart wait on it, and dev reloads queued one behind another.
STARTUP_CHECK_INTERVAL_SECONDS = 24 * 3600
# Let the server finish starting before pip competes with it for disk and CPU.
STARTUP_UPDATE_DELAY_SECONDS = 30


@dataclass
class YtdlpUpdateJob:
    status: str = "idle"
    target: str = "latest"
    started_at: str | None = None
    finished_at: str | None = None
    before_version: str | None = None
    after_version: str | None = None
    error: str | None = None
    output: str = ""


_job = YtdlpUpdateJob()
_lock = asyncio.Lock()


def _hidden_window() -> dict:
    if sys.platform != "win32":
        return {}
    return {"creationflags": subprocess.CREATE_NO_WINDOW}


def _reload_ytdlp() -> dict:
    """Pick up the freshly installed yt-dlp; imports are slow, so off the loop."""
    importlib.invalidate_caches()
    try:
        import yt_dlp

        importlib.reload(yt_dlp.version)
        importlib.reload(yt_dlp)
    except Exception:
        pass
    return installed_info()


def display_path(raw_path: str) -> str:
    if not raw_path:
        return ""
    try:
        path = Path(raw_path).resolve()
        base = settings.base_dir.resolve()
        return str(path.relative_to(base))
    except Exception:
        return raw_path


def load_settings() -> dict:
    raw = SettingsManager(settings.config_file).get_ytdlp_settings()
    policy = raw.get("updatePolicy") or raw.get("update_policy") or "manual"
    if policy not in VALID_POLICIES:
        policy = "manual"
    return {
        "updatePolicy": policy,
        "pinnedVersion": str(raw.get("pinnedVersion") or raw.get("pinned_version") or "").strip(),
    }


def save_settings(raw: dict) -> dict:
    policy = raw.get("updatePolicy") or "manual"
    if policy not in VALID_POLICIES:
        policy = "manual"
    cleaned = {
        "updatePolicy": policy,
        "pinnedVersion": str(raw.get("pinnedVersion") or "").strip(),
    }
    SettingsManager(settings.config_file).set_ytdlp_settings(cleaned)
    return cleaned


def installed_info() -> dict:
    try:
        import yt_dlp

        return {
            "installed": True,
            "version": getattr(yt_dlp.version, "__version__", "unknown"),
            "path": getattr(yt_dlp, "__file__", ""),
            "pathDisplay": display_path(getattr(yt_dlp, "__file__", "")),
            "python": sys.executable,
            "pythonDisplay": display_path(sys.executable),
        }
    except Exception as exc:
        return {
            "installed": False,
            "version": None,
            "path": "",
            "pathDisplay": "",
            "python": sys.executable,
            "pythonDisplay": display_path(sys.executable),
            "error": str(exc),
        }


def status() -> dict:
    return {
        **installed_info(),
        **load_settings(),
        "job": asdict(_job),
    }


def _startup_marker() -> Path:
    return settings.cache_dir / "ytdlp-startup-update"


def _startup_update_due(target: str) -> bool:
    """Whether a startup update should run: once a day, or when the pin changes."""
    try:
        last_target, last_time = _startup_marker().read_text(encoding="utf-8").split("\n", 1)
        return last_target != target or time.time() - float(last_time) >= STARTUP_CHECK_INTERVAL_SECONDS
    except (OSError, ValueError):
        return True


def _record_startup_update(target: str) -> None:
    try:
        _startup_marker().parent.mkdir(parents=True, exist_ok=True)
        _startup_marker().write_text(f"{target}\n{time.time()}", encoding="utf-8")
    except OSError:
        pass


async def maybe_update_on_startup() -> None:
    cfg = load_settings()
    if cfg["updatePolicy"] == "manual":
        return
    if cfg["updatePolicy"] == "startup_pinned" and not cfg["pinnedVersion"]:
        return
    target = cfg["pinnedVersion"] if cfg["updatePolicy"] == "startup_pinned" else "latest"
    if not _startup_update_due(target):
        return
    _record_startup_update(target)
    await start_update(target, delay=STARTUP_UPDATE_DELAY_SECONDS)


async def start_update(target: str = "latest", *, delay: float = 0) -> dict:
    if target != "latest":
        target = str(target or "").strip()
        if not target:
            raise ValueError("Pinned yt-dlp version is required")
    async with _lock:
        if _job.status in {"queued", "running"}:
            return asdict(_job)
        _job.status = "queued"
        _job.target = target
        _job.started_at = None
        _job.finished_at = None
        _job.before_version = (await asyncio.to_thread(installed_info)).get("version")
        _job.after_version = None
        _job.error = None
        _job.output = ""
        asyncio.create_task(_run_update(target, delay=delay))
        return asdict(_job)


def _pip_log() -> Path:
    return settings.cache_dir / "ytdlp-update.log"


def _read_pip_log() -> str:
    try:
        return _pip_log().read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


async def _run_update(target: str, *, delay: float = 0) -> None:
    if delay:
        await asyncio.sleep(delay)
    _job.status = "running"
    _job.started_at = datetime.utcnow().isoformat()
    package = "yt-dlp" if target == "latest" else f"yt-dlp=={target}"
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", package]
    if target == "latest":
        cmd.extend(["--upgrade-strategy", "eager"])
    try:
        # A child process watched from the event loop rather than a thread
        # blocking in subprocess.run: Python joins executor threads at exit, so
        # a running pip used to hold the server open on shutdown and restart.
        # On shutdown pip simply finishes on its own.
        # Output goes to a file: an unread pipe could fill and stall pip.
        _pip_log().parent.mkdir(parents=True, exist_ok=True)
        with _pip_log().open("w", encoding="utf-8", errors="replace") as log:
            proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, **_hidden_window())
        while proc.poll() is None:
            await asyncio.sleep(1)
        _job.output = (await asyncio.to_thread(_read_pip_log))[-12000:]
        if proc.returncode != 0:
            _job.status = "failed"
            _job.error = f"pip exited with code {proc.returncode}"
            return

        _job.after_version = (await asyncio.to_thread(_reload_ytdlp)).get("version")
        _job.status = "completed"
    except Exception as exc:
        _job.status = "failed"
        _job.error = str(exc)
    finally:
        _job.finished_at = datetime.utcnow().isoformat()
