"""Shared tag application helpers.

Routers, imports, and auto-tag jobs all go through this module so aliases,
implications, usage counts, categories, and updated_at behave consistently.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import Post, Tag, TagAlias, TagCategory, TagImplication
from ..models.post import PostTag


def qualifier_display_name(raw: str) -> str | None:
    """Keep the booru spelling when a qualified tag is typed or imported.

    normalize_tag() flattens ``evie_(stellar_blade)`` to ``evie_stellar_blade``,
    which is what makes both spellings find each other in search - but it also
    loses the parentheses the display name exists to preserve. Recover them from
    the raw input so hand-typed booru tags read the same as tagger-supplied
    ones. Returns None for ordinary tags, which keeps the existing
    "underscores become spaces" fallback.
    """
    text = re.sub(r"\s+", " ", str(raw or "").strip().lower())
    if "(" not in text or ")" not in text:
        return None
    return text.replace("_", " ").strip()


def booru_spelling(raw: str) -> str:
    """A tag the way boorus write it: lowercase and underscored, punctuation kept."""
    return re.sub(r"\s+", "_", str(raw or "").strip().lower()).strip("_")


def tag_spelling(tag: Tag) -> str:
    """The booru spelling of a stored tag, recovered from its display name."""
    candidate = booru_spelling(tag.display_name or "")
    return candidate if candidate and normalize_tag(candidate) == tag.name else tag.name


def normalize_tag(raw: str) -> str:
    tag = re.sub(r"\s+", "_", str(raw or "").strip().lower())
    tag = re.sub(r"[^\w:.-]+", "_", tag)
    tag = re.sub(r"_+", "_", tag)
    return tag.strip("_")


async def process_tags_for_post(
    db: AsyncSession,
    post_id: int,
    tag_names: list[str],
    *,
    owner_id: int,
    categories: dict[str, str] | None = None,
    display_names: dict[str, str] | None = None,
):
    """Append tags to a post using direct SQL inserts.

    ``owner_id`` scopes every tag/category/alias lookup and new-row creation
    to this user's own library - tags are private per library, shared only
    through a LibraryShare, same as posts. It's always the post's owner
    (mutations are owner-only), never a shared-library viewer.
    """
    if not tag_names:
        return

    categories = {normalize_tag(k): v for k, v in (categories or {}).items()}
    # Source spellings from the tagger, e.g. "miyu (blue archive)" for the
    # stored "miyu_blue_archive". Display only; "name" remains the key.
    display_names = {normalize_tag(k): v for k, v in (display_names or {}).items()}
    resolved_tag_ids = set()

    cat_result = await db.execute(select(TagCategory).where(TagCategory.owner_id == owner_id))
    category_by_name = {cat.name: cat for cat in cat_result.scalars().all()}
    default_cat_id = category_by_name.get("general").id if category_by_name.get("general") else 1

    for raw_name in tag_names:
        tag_name = normalize_tag(raw_name)
        if not tag_name:
            continue

        alias_result = await db.execute(
            select(TagAlias)
            .options(selectinload(TagAlias.target))
            .where(TagAlias.alias_name == tag_name, TagAlias.owner_id == owner_id)
        )
        alias = alias_result.scalars().first()
        if alias and alias.target:
            tag_name = alias.target.name

        category_name = categories.get(tag_name, "general")
        category = category_by_name.get(category_name) or category_by_name.get("general")
        category_id = category.id if category else default_cat_id

        tag_result = await db.execute(select(Tag).where(Tag.name == tag_name, Tag.owner_id == owner_id))
        tag = tag_result.scalars().first()

        display_name = display_names.get(tag_name) or qualifier_display_name(raw_name)
        if not tag:
            tag = Tag(owner_id=owner_id, name=tag_name, category_id=category_id, display_name=display_name)
            db.add(tag)
            await db.flush()
        else:
            if tag.category_id == default_cat_id and category_id != default_cat_id:
                tag.category_id = category_id
            # Backfill older rows, but never overwrite a spelling already stored.
            if display_name and not tag.display_name:
                tag.display_name = display_name

        resolved_tag_ids.add(tag.id)

        impl_result = await db.execute(
            select(TagImplication).where(TagImplication.antecedent_id == tag.id)
        )
        for impl in impl_result.scalars().all():
            resolved_tag_ids.add(impl.consequent_id)

    for tag_id in resolved_tag_ids:
        existing = await db.execute(
            select(PostTag).where(
                PostTag.c.post_id == post_id,
                PostTag.c.tag_id == tag_id,
            )
        )
        if not existing.first():
            await db.execute(insert(PostTag).values(post_id=post_id, tag_id=tag_id))
            await db.execute(
                Tag.__table__.update().where(Tag.id == tag_id).values(
                    usage_count=Tag.usage_count + 1
                )
            )


async def replace_tags_for_post(
    db: AsyncSession,
    post,
    tag_names: list[str],
    *,
    categories: dict[str, str] | None = None,
    display_names: dict[str, str] | None = None,
):
    """Replace a post's tag set and adjust usage counts."""
    result = await db.execute(
        select(Tag).join(PostTag, PostTag.c.tag_id == Tag.id).where(PostTag.c.post_id == post.id)
    )
    old_tags = list(result.scalars().all())
    for tag in old_tags:
        tag.usage_count = max(0, (tag.usage_count or 0) - 1)

    await db.execute(delete(PostTag).where(PostTag.c.post_id == post.id))
    await process_tags_for_post(
        db, post.id, tag_names, owner_id=post.owner_id, categories=categories, display_names=display_names
    )
    post.updated_at = datetime.utcnow()


class TagAliasConflict(Exception):
    """The alias name is already taken by another alias."""


@dataclass
class TagAliasResult:
    alias: TagAlias
    merged_posts: int = 0
    renamed: bool = False


async def alias_tag(
    db: AsyncSession,
    owner_id: int,
    alias_raw: str,
    target_raw: str,
    *,
    sankaku_name: str | None = None,
) -> TagAliasResult:
    """Make ``alias_raw`` an alias of ``target_raw``, folding in an existing tag.

    Both names go through normalize_tag(), the same as every tag the library
    stores - an alias typed as ``honoka_(dead_or_alive)`` must match the stored
    ``honoka_dead_or_alive`` that the tagging path looks it up by.

    When the alias name is already a tag, its posts move onto the target and
    the old tag is removed, so a Sankaku spelling joins the Danbooru one. When
    the target does not exist yet, the existing tag is renamed to it instead.

    ``sankaku_name`` is the spelling a Sankaku import arrived with; it is kept
    on the target so Sankaku searches can still find the tag. A merged tag
    whose posts came from Sankaku hands its spelling over the same way.
    Repeating an alias that already points at the same target is not an error,
    so an import can record the Sankaku spelling every time it sees one.
    """
    alias_name = normalize_tag(alias_raw)
    target_name = normalize_tag(target_raw)
    if not alias_name or not target_name:
        raise ValueError("Both the alias and the canonical tag are required")
    if alias_name == target_name:
        raise ValueError("A tag cannot be an alias of itself")

    existing_alias = (
        await db.execute(
            select(TagAlias)
            .options(selectinload(TagAlias.target))
            .where(TagAlias.alias_name == alias_name, TagAlias.owner_id == owner_id)
        )
    ).scalars().first()
    if existing_alias:
        target_alias_name = (
            await db.execute(
                select(TagAlias)
                .options(selectinload(TagAlias.target))
                .where(TagAlias.alias_name == target_name, TagAlias.owner_id == owner_id)
            )
        ).scalars().first()
        wanted = target_alias_name.target.name if target_alias_name and target_alias_name.target else target_name
        if not existing_alias.target or existing_alias.target.name != wanted:
            raise TagAliasConflict(f"{alias_name} is already an alias of another tag")
        if sankaku_name and not existing_alias.target.sankaku_name:
            existing_alias.target.sankaku_name = booru_spelling(sankaku_name)
            await db.commit()
        return TagAliasResult(alias=existing_alias)

    # Point at the end of an existing alias rather than building a chain.
    target_alias = await db.execute(
        select(TagAlias)
        .options(selectinload(TagAlias.target))
        .where(TagAlias.alias_name == target_name, TagAlias.owner_id == owner_id)
    )
    forwarded = target_alias.scalars().first()
    if forwarded and forwarded.target:
        target_name = forwarded.target.name
        if target_name == alias_name:
            raise ValueError(f"{target_raw} is already an alias of {alias_name}")

    source = await _owned_tag(db, owner_id, alias_name)
    target = await _owned_tag(db, owner_id, target_name)
    result = TagAliasResult(alias=None)  # type: ignore[arg-type]

    # The merged-away tag's spelling, when its posts came from Sankaku.
    inherited = None
    if source is not None and await _tag_has_sankaku_posts(db, source):
        inherited = source.sankaku_name or tag_spelling(source)

    if target is None:
        if source is None:
            raise LookupError(f"Target tag not found: {target_raw}")
        source.name = target_name
        source.display_name = qualifier_display_name(target_raw)
        target, source = source, None
        result.renamed = True

    if source is not None:
        result.merged_posts = await _merge_tag(db, source, target)

    spelling = booru_spelling(sankaku_name) if sankaku_name else inherited
    if spelling and not target.sankaku_name and normalize_tag(spelling) != target.name:
        target.sankaku_name = spelling

    alias = TagAlias(owner_id=owner_id, alias_name=alias_name, target_id=target.id)
    db.add(alias)
    await db.commit()
    await db.refresh(alias, ["target"])
    result.alias = alias
    return result


async def _tag_has_sankaku_posts(db: AsyncSession, tag: Tag) -> bool:
    found = await db.execute(
        select(Post.id)
        .join(PostTag, PostTag.c.post_id == Post.id)
        .where(
            PostTag.c.tag_id == tag.id,
            (Post.source.like("%sankakucomplex.com%")) | (Post.source.like("%sankaku.app%")),
        )
        .limit(1)
    )
    return found.first() is not None


async def _owned_tag(db: AsyncSession, owner_id: int, name: str) -> Tag | None:
    found = await db.execute(select(Tag).where(Tag.name == name, Tag.owner_id == owner_id))
    return found.scalars().first()


async def _merge_tag(db: AsyncSession, source: Tag, target: Tag) -> int:
    """Move every post, alias, and implication from ``source`` onto ``target``."""
    source_posts = set(
        (await db.execute(select(PostTag.c.post_id).where(PostTag.c.tag_id == source.id))).scalars().all()
    )
    target_posts = set(
        (await db.execute(select(PostTag.c.post_id).where(PostTag.c.tag_id == target.id))).scalars().all()
    )
    moved = sorted(source_posts - target_posts)
    for post_id in moved:
        await db.execute(insert(PostTag).values(post_id=post_id, tag_id=target.id))
    target.usage_count = (target.usage_count or 0) + len(moved)

    await db.execute(
        TagAlias.__table__.update().where(TagAlias.target_id == source.id).values(target_id=target.id)
    )

    # Re-point implications, dropping any that would now imply themselves or
    # duplicate one the target already has.
    implications = (
        await db.execute(
            select(TagImplication).where(
                (TagImplication.antecedent_id == source.id) | (TagImplication.consequent_id == source.id)
            )
        )
    ).scalars().all()
    existing_pairs = {
        (row.antecedent_id, row.consequent_id)
        for row in (
            await db.execute(
                select(TagImplication).where(
                    (TagImplication.antecedent_id == target.id) | (TagImplication.consequent_id == target.id)
                )
            )
        ).scalars().all()
    }
    for implication in implications:
        antecedent = target.id if implication.antecedent_id == source.id else implication.antecedent_id
        consequent = target.id if implication.consequent_id == source.id else implication.consequent_id
        if antecedent == consequent or (antecedent, consequent) in existing_pairs:
            await db.delete(implication)
            continue
        implication.antecedent_id = antecedent
        implication.consequent_id = consequent
        existing_pairs.add((antecedent, consequent))

    await db.execute(delete(PostTag).where(PostTag.c.tag_id == source.id))
    await db.flush()
    await db.delete(source)
    return len(moved)
