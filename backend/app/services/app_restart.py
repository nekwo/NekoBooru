"""Runtime restart coordination for NekoBooru launchers."""
from __future__ import annotations

import atexit
import logging
import os
import sys
import threading
from typing import Any, Callable

from ..runtime_paths import runtime_paths

_restart_lock = threading.Lock()
_restart_handler: Callable[[], dict[str, Any]] | None = None
_exit_when_stopped = False


def register_restart_handler(handler: Callable[[], dict[str, Any]]) -> None:
    """Register a process-level restart handler.

    Some launchers, such as Uvicorn reload mode, intentionally do not register
    a handler because they are controlled by an external supervisor.
    """
    global _restart_handler
    with _restart_lock:
        _restart_handler = handler


def clear_restart_handler() -> None:
    global _restart_handler
    with _restart_lock:
        _restart_handler = None


def restart_status() -> dict[str, Any]:
    with _restart_lock:
        available = _restart_handler is not None
    return {
        "available": available,
        "mode": "packaged" if runtime_paths.packaged else "source",
        "message": (
            "NekoBooru can restart itself."
            if available
            else "Restart is unavailable for this launcher. Restart this NekoBooru process from the terminal."
        ),
    }


def request_restart() -> dict[str, Any]:
    with _restart_lock:
        handler = _restart_handler
    if handler is None:
        raise RuntimeError(restart_status()["message"])
    return handler()


def exit_when_server_stops() -> None:
    """A launcher's restart handler calls this once the replacement is on its way.

    Left to itself the old process lingers after uvicorn stops: asyncio waits up
    to five minutes for running thread jobs (tagging, ffmpeg, downloads) and the
    interpreter then frees every loaded model. The restart waiter gives up after
    30 s, so each restart took that long. exit_if_restarting() ends it instead.
    """
    global _exit_when_stopped
    _exit_when_stopped = True


def restart_pending() -> bool:
    return _exit_when_stopped


def exit_if_restarting() -> None:
    """End the process now if a restart is pending; the lifespan's last step."""
    if not _exit_when_stopped:
        return
    # The launchers' own cleanup (instance lock, AI worker) is registered here.
    run_exitfuncs = getattr(atexit, "_run_exitfuncs", None)
    if run_exitfuncs is not None:
        run_exitfuncs()
    logging.shutdown()
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream is not None:
                stream.flush()
        except (OSError, ValueError):
            pass
    os._exit(0)
