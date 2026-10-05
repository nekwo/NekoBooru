import api from '../api/client'
import { SANKAKU_CHAN, booruSearchTag, sankakuSearchUrl } from './booruSearchTag.js'

// The Sankaku search a tag link points at before anything is looked up: the
// stored Sankaku name when the tag has one, else the booru spelling.
export function sankakuFallbackUrl(tag, origin = SANKAKU_CHAN) {
  return sankakuSearchUrl(tag?.sankakuName || booruSearchTag(tag?.name, tag?.displayName), origin)
}

// A plain left click on a Sankaku link: when the tag has no Sankaku name yet,
// ask the backend for one first (it looks it up once and remembers it), so
// honoka_doa searches honoka_(dead_or_alive) there. Middle and modified clicks
// keep the link's own fallback href. Returns the name searched, which the
// caller can keep on the tag so the next click goes straight there.
export async function openSankakuSearch(event, tag, origin = SANKAKU_CHAN, deps = {}) {
  if (tag?.sankakuName || event?.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return tag?.sankakuName || ''
  }
  event.preventDefault()
  const resolveName = deps.resolveName || ((name) => api.resolveSankakuName(name))
  const openWindow = deps.openWindow || ((url) => window.open(url, '_blank'))

  // Opened inside the click so the popup blocker allows it, then pointed at
  // the search once the name is known.
  const target = openWindow('about:blank')
  let name = booruSearchTag(tag?.name, tag?.displayName)
  try {
    const answer = await resolveName(tag?.name)
    if (answer?.sankakuName) name = answer.sankakuName
  } catch {
    // The booru spelling is still a reasonable search.
  }
  const url = sankakuSearchUrl(name, origin)
  if (target) {
    try { target.opener = null } catch { /* cross-origin already */ }
    target.location.href = url
  } else {
    window.location.assign(url)
  }
  return name
}
