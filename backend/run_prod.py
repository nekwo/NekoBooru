#!/usr/bin/env python
"""Production-style source launcher for NekoBooru."""

import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

_RESTART_WAITER_ARG = "--nekobooru-restart-waiter"


def _backend_dir() -> Path:
    return Path(__file__).resolve().parent


def _health_ok(port: int) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
            return response.status == 200
    except (OSError, TimeoutError, URLError, ValueError):
        return False


def _popen_hidden(args: list[str]) -> subprocess.Popen:
    kwargs = {}
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        kwargs["creationflags"] = (
            subprocess.CREATE_NO_WINDOW
            | subprocess.CREATE_NEW_PROCESS_GROUP
        )
        kwargs["startupinfo"] = startupinfo
    return subprocess.Popen(
        args,
        cwd=str(_backend_dir()),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        **kwargs,
    )


def _restart_waiter(argv: list[str]) -> int:
    try:
        port = int(argv[1]) if len(argv) > 1 else 8772
    except (TypeError, ValueError):
        port = 8772
    executable = argv[2] if len(argv) > 2 else sys.executable
    try:
        old_pid = int(argv[3]) if len(argv) > 3 else 0
    except (TypeError, ValueError):
        old_pid = 0

    # Relaunch the moment the old server has actually exited and released the
    # port. The old process has a 5 s graceful-shutdown cap, so this is quick;
    # health polling remains only for a waiter started without a pid.
    if old_pid:
        sys.path.insert(0, str(_backend_dir()))
        from app.process_wait import wait_for_exit

        wait_for_exit(old_pid, timeout=30)
    else:
        for _ in range(80):
            if not _health_ok(port):
                break
            time.sleep(0.25)
        time.sleep(0.35)
    _popen_hidden([executable, "run_prod.py"])
    return 0


if len(sys.argv) > 1 and sys.argv[1] == _RESTART_WAITER_ARG:
    raise SystemExit(_restart_waiter(sys.argv[1:]))


def _ensure_standard_streams() -> None:
    logs_dir = _backend_dir().parent / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None:
        sys.stdout = open(logs_dir / "dev-backend.out.log", "a", encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = open(logs_dir / "dev-backend.err.log", "a", encoding="utf-8", buffering=1)


def _console_print(message: str) -> None:
    if sys.stdout is not None:
        print(message)


_ensure_standard_streams()


import uvicorn
from app.ai_runtime_link import link_ai_runtime

link_ai_runtime()

from app.config import settings
from app.services.app_restart import register_restart_handler


def _python_executable() -> str:
    scripts_dir = "Scripts" if os.name == "nt" else "bin"
    windowed_exe_name = "pythonw.exe" if os.name == "nt" else "python"
    console_exe_name = "python.exe" if os.name == "nt" else "python"
    repo_venv_dir = _backend_dir().parent / "venv" / scripts_dir
    candidates = [
        repo_venv_dir / windowed_exe_name,
        Path(sys.executable).with_name(windowed_exe_name),
        Path(sys.prefix) / scripts_dir / windowed_exe_name,
        repo_venv_dir / console_exe_name,
        Path(sys.prefix) / scripts_dir / console_exe_name,
        Path(sys.executable),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return sys.executable


if __name__ == "__main__":
    _console_print(f"\n{'='*50}")
    _console_print(f"  {settings.app_name} - Production Server")
    _console_print(f"{'='*50}")
    _console_print(f"  URL: http://{settings.host}:{settings.port}")
    _console_print(f"  API Docs: http://{settings.host}:{settings.port}/docs")
    _console_print(f"  Database: {settings.database_path}")
    _console_print(f"{'='*50}\n")

    server = uvicorn.Server(
        uvicorn.Config(
            "app.main:app",
            host=settings.host,
            port=settings.port,
            reload=False,
            log_level="info",
            access_log=False,
            # Without a cap, one long request (a slow video download, an open
            # progress stream) holds a restart hostage indefinitely.
            timeout_graceful_shutdown=5,
        )
    )
    restart_state = {"requested": False}

    def restart_app():
        if restart_state["requested"]:
            return {"status": "restarting", "message": "Restart is already in progress."}
        restart_state["requested"] = True
        _popen_hidden([
            _python_executable(),
            "run_prod.py",
            _RESTART_WAITER_ARG,
            str(settings.port),
            _python_executable(),
            str(os.getpid()),
        ])
        server.should_exit = True
        return {
            "status": "restarting",
            "message": "NekoBooru is restarting. This page will reconnect shortly.",
            "url": f"http://localhost:{settings.port}",
        }

    register_restart_handler(restart_app)
    server.run()
