r"""Set a NekoBooru account's password locally. Run from the repo root:

    venv\Scripts\python.exe <this file>            (Windows)
    venv/bin/python <this file>                    (Linux/macOS)

Prompts for the password - it is never echoed, never passed as an argument,
and so never lands in shell history.
"""
import getpass
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))
if not (Path.cwd() / "backend").exists():
    sys.exit("Run this from the NekoBooru repo root (the folder containing backend/ and data/).")
sys.path.insert(0, str(Path.cwd() / "backend"))

from app.services.auth import hash_password  # noqa: E402

db_path = Path.cwd() / "data" / "nekobooru.db"
if not db_path.exists():
    sys.exit(f"No database at {db_path}")

conn = sqlite3.connect(db_path)
users = conn.execute("SELECT id, username, is_admin FROM users ORDER BY id").fetchall()
if not users:
    sys.exit("No users exist yet - create the admin account in the web UI instead.")

print("Accounts:")
for uid, name, admin in users:
    print(f"  [{uid}] {name}{'  (admin)' if admin else ''}")

if len(users) == 1:
    target = users[0]
    print(f"\nSetting the password for '{target[1]}'.")
else:
    wanted = input("\nAccount id to change: ").strip()
    match = [u for u in users if str(u[0]) == wanted]
    if not match:
        sys.exit("No account with that id.")
    target = match[0]

pw = getpass.getpass("New password (min 8 chars, not echoed): ")
if len(pw) < 8:
    sys.exit("Password must be at least 8 characters.")
if pw != getpass.getpass("Confirm password: "):
    sys.exit("Passwords did not match - nothing changed.")

conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(pw), target[0]))
removed = conn.execute("DELETE FROM sessions WHERE user_id = ?", (target[0],)).rowcount
conn.commit()
conn.close()

print(f"\nPassword updated for '{target[1]}'. Signed out {removed} existing session(s).")
print("Log in at http://localhost:8772 with the new password.")
