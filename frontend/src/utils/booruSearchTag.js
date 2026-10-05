// NekoBooru stores tag names flattened (backend/app/services/tagging.py
// normalize_tag): anything but letters, digits, _ : . - becomes "_" and is
// trimmed, so Gelbooru's "seitokai_ni_mo_ana_wa_aru!" is kept as
// "seitokai_ni_mo_ana_wa_aru" and "miyu_(blue_archive)" as "miyu_blue_archive".
// The original spelling survives only in the display name.
export function normalizeTagName(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_:.-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// The tag as another booru spells it: the display name in tag form, but only
// when it flattens back to the stored name - a hand-written display name that
// says something else must not change what gets searched.
export function booruSearchTag(name, displayName = '') {
  const stored = String(name ?? '')
  const candidate = String(displayName ?? '').trim().replace(/\s+/g, '_')
  if (candidate && candidate.toLowerCase() !== stored && normalizeTagName(candidate) === stored) {
    return candidate.toLowerCase()
  }
  return stored
}

// Classic Sankaku Channel and the newer sankaku.app search the same posts.
export const SANKAKU_CHAN = 'https://chan.sankakucomplex.com'
export const SANKAKU_APP = 'https://sankaku.app'

export function sankakuSearchUrl(tag, origin = SANKAKU_CHAN) {
  return `${origin}/?tags=${encodeURIComponent(tag)}`
}
