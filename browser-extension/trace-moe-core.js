// Pure trace.moe helpers shared by the content script (trace-moe-buttons.js)
// and the background worker: reading a release filename, phrasing the scene
// description, and turning the show's titles into a Danbooru copyright tag.

// "Even.the.Student.Council.Has.Its.Holes.S01E01.720p...mkv" -> title, season,
// episode. Covers scene-style S01E01 / 1x01, "Season 2 Episode 5", and fansub
// "[Group] Title - 05 (1080p)" names.
function parseTraceMoeFilename(raw) {
  const filename = String(raw || '').trim()
  const stem = filename
    .replace(/\.(mkv|mp4|avi|webm|m4v|ts|mov)$/i, '')
    .replace(/^(\s*\[[^\]]*\]\s*)+/, '')
  let season = null
  let episode = null
  let cut = -1
  const patterns = [
    [/\bS(\d{1,2})[ ._-]*E(\d{1,4})\b/i, 'both'],
    [/\b(\d{1,2})x(\d{2,4})\b/, 'both'],
    [/\bSeason[ ._-]*(\d{1,2})[ ._-]*(?:Episode|Ep)[ ._-]*(\d{1,4})\b/i, 'both'],
    [/\b(?:Episode|Ep)[ ._-]*(\d{1,4})\b/i, 'episode'],
    [/\s-\s(\d{1,4})(?:v\d)?(?=[\s.([]|$)/, 'episode'],
  ]
  for (const [pattern, kind] of patterns) {
    const match = stem.match(pattern)
    if (!match) continue
    if (kind === 'both') {
      season = Number.parseInt(match[1], 10)
      episode = Number.parseInt(match[2], 10)
    } else {
      episode = Number.parseInt(match[1], 10)
    }
    cut = match.index
    break
  }
  if (season === null) {
    const seasonMatch = stem.match(/\b(?:Season[ ._-]*|S)(\d{1,2})\b/i)
    if (seasonMatch) {
      season = Number.parseInt(seasonMatch[1], 10)
      if (cut < 0 || seasonMatch.index < cut) cut = seasonMatch.index
    }
  }
  const title = cut > 0
    ? stem.slice(0, cut).replace(/[._]+/g, ' ').replace(/[\s-]+$/, '').trim()
    : ''
  return { filename, title, season, episode }
}

function formatTraceMoeTime(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return ''
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return ''
  const total = Math.floor(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
}

// One readable line for the semantic description plus searchable tags.
function traceMoeSceneDescription(meta = {}) {
  const parts = []
  const title = meta.title || ''
  const where = [
    Number.isInteger(meta.season) ? `Season ${meta.season}` : '',
    Number.isInteger(meta.episode) ? `Episode ${meta.episode}` : '',
  ].filter(Boolean).join(', ')
  const start = formatTraceMoeTime(meta.start)
  const end = formatTraceMoeTime(meta.end)
  const duration = formatTraceMoeTime(meta.duration)
  let scene = start && end && start !== end ? `${start}–${end}` : start
  if (scene && duration) scene += ` of ${duration}`
  const head = [title, where].filter(Boolean).join(' — ')
  if (head) parts.push(scene ? `${head}, at ${scene}.` : `${head}.`)
  else if (scene) parts.push(`Scene at ${scene}.`)
  if (meta.filename) parts.push(`Source file: ${meta.filename}`)

  const tags = []
  if (Number.isInteger(meta.season)) tags.push(`season_${meta.season}`)
  if (Number.isInteger(meta.episode)) tags.push(`episode_${meta.episode}`)
  if (Number.isInteger(meta.season) && Number.isInteger(meta.episode)) {
    tags.push(`s${String(meta.season).padStart(2, '0')}e${String(meta.episode).padStart(2, '0')}`)
  }
  return { description: parts.join(' '), tags }
}

// Titles as trace.moe shows them (romaji, English, aliases, the filename's
// title) -> Danbooru-style tag spellings to try, best first. Danbooru names
// shows in Latin script, so native-script titles are dropped; the English
// and alias spellings still land on the right tag through Danbooru's aliases.
function traceMoeTagCandidates(titles = []) {
  const seen = new Set()
  const out = []
  for (const raw of titles) {
    const tag = String(raw || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[*,]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
    if (tag.length < 2 || !/[a-z]/.test(tag) || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

// The copyright tag Danbooru actually uses, out of a tags.json answer: the
// most-posted one. Alias stubs come back with zero posts and never win.
function pickDanbooruCopyright(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && Number(row.category) === 3 && Number(row.post_count) > 0 && !row.is_deprecated)
    .sort((a, b) => Number(b.post_count) - Number(a.post_count))[0]?.name || ''
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseTraceMoeFilename,
    formatTraceMoeTime,
    traceMoeSceneDescription,
    traceMoeTagCandidates,
    pickDanbooruCopyright,
  }
}
