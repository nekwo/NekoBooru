#!/usr/bin/env python
"""Map tags from posts already imported from Sankaku to the booru spelling.

Sankaku spells qualified characters and series in full -
``honoka_(dead_or_alive)`` - where Danbooru, Gelbooru, and Safebooru write
``honoka_(doa)``. New Sankaku imports take the Danbooru spelling themselves;
this does the same for the posts imported before that.

Only character and copyright tags on posts whose source is Sankaku are looked
at, and each is looked up on Danbooru once - a few requests per tag, for a
handful of tags. Each one that Danbooru spells differently is then made an
alias of the Danbooru tag: its posts move over, the old tag goes, and the
Sankaku spelling is kept on the tag for Sankaku searches.

Run with the project venv. Dry run by default; nothing is written until
``--apply``:

    venv\\Scripts\\python.exe map_sankaku_tags.py
    venv\\Scripts\\python.exe map_sankaku_tags.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

SANKAKU_SOURCE = "(posts.source LIKE '%sankakucomplex.com%' OR posts.source LIKE '%sankaku.app%')"


def sankaku_tags(con: sqlite3.Connection) -> list[dict]:
    """Qualified character/copyright tags on posts imported from Sankaku."""
    from app.services.tagging import booru_spelling, normalize_tag  # type: ignore

    rows = con.execute(
        f"""
        SELECT tags.id, tags.owner_id, tags.name, tags.display_name, tag_categories.name, COUNT(posts.id)
        FROM tags
        JOIN tag_categories ON tag_categories.id = tags.category_id
        JOIN post_tags ON post_tags.tag_id = tags.id
        JOIN posts ON posts.id = post_tags.post_id
        WHERE tag_categories.name IN ('character', 'copyright') AND {SANKAKU_SOURCE}
        GROUP BY tags.id
        ORDER BY tags.name
        """
    ).fetchall()
    found = []
    for tag_id, owner_id, name, display_name, category, posts in rows:
        spelling = booru_spelling(display_name or "")
        if "_(" not in spelling or normalize_tag(spelling) != name:
            continue
        found.append(
            {"id": tag_id, "owner_id": owner_id, "name": name, "spelling": spelling, "category": category, "posts": posts}
        )
    return found


async def apply_mappings(mappings: list[tuple[dict, str]]) -> list[str]:
    from app.database import async_session, init_db  # type: ignore
    from app.services.tagging import TagAliasConflict, alias_tag  # type: ignore

    # Runs the app's own migrations first, so the Sankaku-name column exists
    # even if the updated app has not been started yet.
    await init_db()
    done = []
    for tag, target in mappings:
        async with async_session() as db:
            try:
                result = await alias_tag(db, tag["owner_id"], tag["spelling"], target, sankaku_name=tag["spelling"])
            except (TagAliasConflict, LookupError, ValueError) as exc:
                done.append(f"  {tag['spelling']:44} skipped: {exc}")
                continue
        how = "renamed" if result.renamed else f"merged {result.merged_posts} post(s)"
        done.append(f"  {tag['spelling']:44} -> {target} ({how})")
    return done


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="merge the tags (default is a dry run)")
    args = parser.parse_args()

    from app.config import settings  # type: ignore
    from app.services.site_imports import MAX_NAME_LOOKUPS, danbooru_names  # type: ignore

    db = Path(settings.database_path)
    if not db.exists():
        print(f"Database not found: {db}", file=sys.stderr)
        return 1
    con = sqlite3.connect(str(db), timeout=30)
    try:
        tags = sankaku_tags(con)
    finally:
        con.close()

    print(f"Database : {db}")
    print(f"Mode     : {'APPLY' if args.apply else 'dry run (nothing will be written)'}")
    print(f"Qualified character/copyright tags on Sankaku posts: {len(tags)}", flush=True)
    if not tags:
        return 0

    categories = {tag["spelling"]: tag["category"] for tag in tags}
    spellings = [tag["spelling"] for tag in tags]
    renames: dict[str, str] = {}
    # danbooru_names() looks up at most MAX_NAME_LOOKUPS tags per call.
    for offset in range(0, len(spellings), MAX_NAME_LOOKUPS):
        renames.update(asyncio.run(danbooru_names(spellings[offset:offset + MAX_NAME_LOOKUPS], categories)))
    mappings = [(tag, renames[tag["spelling"]]) for tag in tags if tag["spelling"] in renames]
    print(f"Spelled differently on Danbooru: {len(mappings)}\n")
    for tag, target in mappings:
        print(f"  {tag['spelling']:44} -> {target}   ({tag['posts']} Sankaku post(s))")

    if not args.apply:
        print("\nDry run - nothing written. Re-run with --apply to merge these.")
        return 0
    print()
    for line in asyncio.run(apply_mappings(mappings)):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
