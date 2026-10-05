"""Wait for another process to exit, for the restart helpers.

Kept free of app imports: the restart waiter runs it before anything else.
"""
from __future__ import annotations

import os
import time


def wait_for_exit(pid: int, timeout: float = 30.0) -> bool:
    """True once ``pid`` has exited, False if it is still running after ``timeout``."""
    if pid <= 0:
        return True
    if os.name == "nt":
        import ctypes

        synchronize = 0x00100000
        wait_object_0 = 0
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            # Already gone - there is no process left to open.
            return True
        try:
            return kernel32.WaitForSingleObject(handle, int(timeout * 1000)) == wait_object_0
        finally:
            kernel32.CloseHandle(handle)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            pass
        time.sleep(0.1)
    return False
