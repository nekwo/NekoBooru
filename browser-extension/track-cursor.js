// Content script with two jobs, both driven off the right-click:
//
// 1. Record where the cursor is — and whether a <video> sits under it — so the
//    background worker can open the upload popup near the pointer and route a
//    poster/overlay click to yt-dlp.
//
// 2. Keep the browser's NATIVE context menu reachable over media. Some sites
//    (X/Twitter, etc.) attach their own `contextmenu` handler that cancels the
//    native menu and shows a custom one ("Copy video address"), which hides the
//    extension's "Download to NekoBooru" item. When the right-click lands on a
//    video or image we stop those page handlers from running so the native menu
//    appears. We only do this over media, so the site's own menus elsewhere
//    (text, links, empty page) are left untouched.

// Elements stacked under a viewport point, top-first. Uses elementsFromPoint so
// it still finds media beneath a transparent overlay (exactly how X covers its
// player) and a touch off the element still counts.
let lastEditableTarget = null

// A post page can request the same reverse-search stack as the native context
// menu. The background worker validates the sender against the saved instance
// URL before acting; this listener is only the isolated-world bridge.
window.addEventListener('message', (event) => {
  const message = event.data
  if (event.source !== window || event.origin !== location.origin) return
  if (message?.source !== 'nekobooru-app') return
  // Lets a post page know up front that the extension is here, so it can
  // decide what to offer before the click rather than after a timeout.
  if (message.type === 'nekobooru-extension-ping') {
    window.postMessage({ type: 'nekobooru-extension-pong', requestId: message.requestId, reverseSearch: true }, location.origin)
    return
  }
  if (message.type !== 'nekobooru-reverse-search-request') return
  try {
    chrome.runtime.sendMessage({
      type: 'nekobooru-open-reverse-search',
      requestId: message.requestId,
      mode: message.mode,
      src: message.mediaUrl,
      mediaType: message.mediaType,
      filename: message.filename,
      dataUrl: message.dataUrl,
    }, (response) => {
      const error = chrome.runtime.lastError
      window.postMessage({
        type: 'nekobooru-reverse-search-result',
        requestId: message.requestId,
        ok: !error && response?.ok === true,
        error: error?.message || response?.error || '',
      }, location.origin)
    })
  } catch (error) {
    window.postMessage({
      type: 'nekobooru-reverse-search-result',
      requestId: message.requestId,
      ok: false,
      error: error?.message || 'The extension context is unavailable.',
    }, location.origin)
  }
})

function elementsUnder(x, y) {
  try {
    return document.elementsFromPoint(x, y)
  } catch {
    return []
  }
}

function mediaFromStack(stack) {
  return stack.find((el) => el.tagName === 'VIDEO' || el.tagName === 'IMG') || null
}

function mediaUrlFromElement(media) {
  const raw = media?.currentSrc || media?.src || ''
  if (!raw) return ''
  try {
    return new URL(raw, location.href).href
  } catch {
    return raw
  }
}

const EDITABLE_SELECTOR = 'textarea, input, [contenteditable="true"], [role="textbox"]'

// composedPath() sees through shadow DOM, where event.target is only the host.
function editableTargetFromEvent(event) {
  for (const el of event.composedPath?.() || []) {
    if (el?.matches?.(EDITABLE_SELECTOR)) return el
  }
  return event.target?.closest?.(EDITABLE_SELECTOR) || null
}

// Shadow-DOM-aware helpers: a component page (X's chat) keeps its composer in
// shadow roots that document.querySelector and parentElement cannot cross.
function parentAcrossShadow(node) {
  if (node?.parentElement) return node.parentElement
  const root = node?.parentNode
  return root instanceof ShadowRoot ? root.host : null
}

function deepQueryAll(selector, root = document) {
  const found = [...root.querySelectorAll(selector)]
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) found.push(...deepQueryAll(selector, el.shadowRoot))
  }
  return found
}

function deepActiveElement() {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

function deepElementsUnder(x, y) {
  const stack = elementsUnder(x, y)
  const top = stack[0]
  if (top?.shadowRoot?.elementsFromPoint) {
    try {
      return [...top.shadowRoot.elementsFromPoint(x, y), ...stack]
    } catch {
      return stack
    }
  }
  return stack
}

// Each way of handing a file to a page is tried in turn, and one only counts
// once a new preview appears. X redesigns its composers (the DM chat most
// recently), and every method can be accepted silently while doing nothing.
async function pasteFileIntoEditable(file) {
  const target = resolveEditableTarget()
  if (!target) return { ok: false, error: `No text box found to insert into (${pageDiagnostics()}).` }

  const attempts = []
  if (isXHost()) attempts.push(['file-input', () => attachFileViaInput(target, file)])
  attempts.push(['paste', () => dispatchFileEvent(target, file, 'paste')])
  attempts.push(['drop', () => dispatchFileEvent(target, file, 'drop')])

  const scope = composerScope(target)
  const tried = []
  for (const [method, attempt] of attempts) {
    const before = previewCount(scope)
    const result = attempt()
    if (!result.ok) {
      tried.push(`${method}: ${result.error}`)
      continue
    }
    if (await previewAppeared(scope, before)) return { ...result, method, verified: true }
    tried.push(`${method}: no preview appeared`)
  }
  return { ok: false, error: `The page did not take the file (${tried.join('; ')}; target: ${describeElement(target)}).` }
}

const X_COMPOSER_TEXT_BOXES = '[data-testid="dm-composer-textarea"], [data-testid^="tweetTextarea_"]'

// Where to insert, found again now rather than trusted from the right-click:
// the picker takes focus, and X re-renders its chat box when the window
// blurs, which leaves the remembered element detached (or the focus elsewhere).
function resolveEditableTarget() {
  const candidates = []
  if (lastEditableTarget?.isConnected) candidates.push(lastEditableTarget)
  for (const el of deepElementsUnder(lastContextMenuPoint.x, lastContextMenuPoint.y)) {
    const editable = el.closest?.(EDITABLE_SELECTOR)
    if (editable) {
      candidates.push(editable)
      break
    }
  }
  if (isXHost()) candidates.push(...deepQueryAll(X_COMPOSER_TEXT_BOXES))
  const active = deepActiveElement()
  if (active && active !== document.body && active.matches?.(EDITABLE_SELECTOR)) candidates.push(active)

  const usable = candidates.filter((el) => el?.isConnected && isVisible(el))
  // On X the right box is the one with X's own attach input around it, then
  // any box with an attach input; a stray box (the search field) has neither.
  if (isXHost()) {
    const withKnownInput = usable.find((el) => findFileInputForTarget(el, null)?.matches(X_COMPOSER_FILE_INPUTS))
    if (withKnownInput) return withKnownInput
    const withInput = usable.find((el) => findFileInputForTarget(el, null))
    if (withInput) return withInput
  }
  return usable[0] || null
}

// Enough to tell a wrong frame, a shadow-DOM page, or a renamed composer apart.
function pageDiagnostics() {
  const shadowHosts = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length
  return [
    window === window.top ? 'top frame' : 'iframe',
    location.pathname,
    `${shadowHosts} shadow roots`,
    `${deepQueryAll(X_COMPOSER_TEXT_BOXES).length} X composer boxes`,
    `${deepQueryAll('textarea').length} textareas`,
    `remembered: ${lastEditableTarget ? (lastEditableTarget.isConnected ? describeElement(lastEditableTarget) : 'detached') : 'none'}`,
  ].join(', ')
}

function isVisible(el) {
  const rect = el.getBoundingClientRect?.()
  return !!rect && rect.width > 0 && rect.height > 0
}

function describeElement(el) {
  const testId = el.getAttribute?.('data-testid')
  return `${(el.tagName || '?').toLowerCase()}${testId ? `[${testId}]` : ''}`
}

function dispatchFileEvent(target, file, type) {
  try {
    target.focus?.()
  } catch {
    // Some page-controlled elements reject focus; still try the event.
  }
  const data = new DataTransfer()
  data.items.add(file)
  try {
    if (type === 'paste') {
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    } else {
      for (const name of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: data }))
      }
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
  return { ok: true, files: data.files.length }
}

// The area an attachment preview would appear in: the nearest container around
// the text box that holds a file input, else a few levels up from it.
function composerScope(target) {
  let node = target
  let fallback = target
  for (let depth = 0; node && node !== document.body && depth < 15; depth += 1) {
    if (deepQueryAll('input[type="file"]', node).length) return node
    if (depth === 6) fallback = node
    node = parentAcrossShadow(node)
  }
  return parentAcrossShadow(fallback) || document.body
}

// Any new image, video or canvas in the composer counts as a preview (X's are
// not always object URLs), plus object-URL media anywhere on the page.
function previewCount(scope) {
  const local = deepQueryAll('img, video, canvas, [style*="background-image"]', scope).length
  const page = deepQueryAll('img[src^="blob:"], video[src^="blob:"], [style*="blob:"]').length
  return local + page
}

async function previewAppeared(scope, before, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (previewCount(scope) > before) return true
  }
  return false
}

// X's composers name their attach inputs; the DM chat's sits above the
// message form rather than inside it.
const X_COMPOSER_FILE_INPUTS = '[data-testid="dm-composer-file-input"], [data-testid="fileInput"]'

function attachFileViaInput(target, file) {
  const input = findFileInputForTarget(target, file)
  if (!input) return { ok: false, error: 'No file input in this composer.' }

  const data = new DataTransfer()
  data.items.add(file)
  input.files = data.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

  return {
    ok: true,
    files: input.files.length,
    method: 'file-input',
  }
}

// The nearest container around the text box that holds a file input, never a
// page-wide search: that used to pick an unrelated input elsewhere on the page
// (X's new chat composer keeps its own), report success, and attach nothing.
function findFileInputForTarget(target, file) {
  let node = target
  for (let depth = 0; node && node !== document.body && depth < 15; depth += 1) {
    const inputs = deepQueryAll('input[type="file"]', node).filter((input) => !input.disabled)
    if (inputs.length) {
      return inputs.find((input) => input.matches(X_COMPOSER_FILE_INPUTS))
        || inputs.sort((a, b) => fileInputScore(b, file) - fileInputScore(a, file))[0]
    }
    node = parentAcrossShadow(node)
  }
  return null
}

function fileInputScore(input, file) {
  const accept = (input.getAttribute('accept') || '').toLowerCase()
  const name = (file?.name || '').toLowerCase()
  const type = (file?.type || '').toLowerCase()
  let score = 0
  if (input.multiple) score += 1
  if (!accept) score += 1
  if (accept.includes(type)) score += 10
  if (type.startsWith('video/') && accept.includes('video')) score += 8
  if (type.startsWith('image/') && accept.includes('image')) score += 8
  if (name.endsWith('.mp4') && accept.includes('.mp4')) score += 6
  if (name.endsWith('.webm') && accept.includes('.webm')) score += 6
  if (name.endsWith('.gif') && accept.includes('.gif')) score += 6
  return score
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'nekobooru-paste-media-file') return
  ;(async () => {
    try {
      const blob = await dataUrlToBlob(msg.dataUrl)
      const file = new File([blob], msg.filename || 'nekobooru-media', {
        type: msg.mime || blob.type || 'application/octet-stream',
      })
      const result = await pasteFileIntoEditable(file)
      sendResponse({
        ...result,
        fileSize: file.size,
        expectedSize: msg.size || null,
      })
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) })
    }
  })()
  return true
})

async function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error('No media bytes were received.')
  }
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error('Could not decode media bytes.')
  return response.blob()
}

function isXHost() {
  return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname.toLowerCase())
}

function normalizedStatusUrl(raw) {
  if (!raw || !isXHost()) return ''
  try {
    const url = new URL(raw, location.origin)
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return ''
    if (!/\/status\/\d+/.test(url.pathname)) return ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function tweetIdFromUrl(raw) {
  const url = normalizedStatusUrl(raw)
  return url.match(/\/status\/(\d+)/)?.[1] || ''
}

function tweetUsernameFromUrl(raw) {
  const url = normalizedStatusUrl(raw)
  return url.match(/\/([^/]+)\/status\/\d+/)?.[1] || ''
}

// /status/<id>/photo/<n> (stills) and /status/<id>/video/<n> (videos) are both
// 1-based and both map onto the same 0-based attachment index.
function xMediaIndexFromUrl(raw) {
  const url = normalizedStatusUrl(raw)
  const match = url.match(/\/(?:photo|video)\/(\d+)/)
  if (!match) return null
  const index = Number.parseInt(match[1], 10)
  return Number.isFinite(index) && index > 0 ? index - 1 : null
}

// A tweet's timestamp link is always the bare status URL, so a status URL read
// off the page loses the attachment the reader opened. Restore it from the
// address bar when both point at the same tweet.
function withLocationMediaIndex(statusUrl) {
  if (!statusUrl || xMediaIndexFromUrl(statusUrl) !== null) return statusUrl
  const current = normalizedStatusUrl(location.href)
  if (!current || tweetIdFromUrl(current) !== tweetIdFromUrl(statusUrl)) return statusUrl
  const suffix = new URL(current).pathname.match(/\/(?:photo|video)\/\d+/)?.[0]
  if (!suffix) return statusUrl
  const url = new URL(statusUrl)
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix
  return url.href
}

function statusUrlFromArticle(article) {
  if (!article) return ''
  const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a')
  const statusLink = timeLink || article.querySelector('a[href*="/status/"]')
  return withLocationMediaIndex(normalizedStatusUrl(statusLink?.getAttribute('href') || statusLink?.href || ''))
}

function normalizeCapturedMediaUrl(raw, type) {
  if (!raw) return ''
  try {
    const url = new URL(raw, location.origin)
    const host = url.hostname.toLowerCase()
    if (host === 'pbs.twimg.com' && url.pathname.includes('/media/')) {
      const inferredFormat = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
      if (!url.searchParams.has('format') && inferredFormat) url.searchParams.set('format', inferredFormat)
      if (url.searchParams.has('format')) url.searchParams.set('name', 'orig')
      url.hash = ''
      return url.href
    }
    if (host.endsWith('video.twimg.com')) {
      url.hash = ''
      return url.href
    }
    if (type === 'image' || type === 'video') return url.href
  } catch {
    // ignore malformed media URLs
  }
  return ''
}

function bestVideoVariant(variants = []) {
  return variants
    .filter((variant) => variant?.url && (!variant.content_type || variant.content_type === 'video/mp4'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
}

function mediaFromLegacyTweet(tweetId, legacy = {}) {
  const mediaList = legacy.extended_entities?.media || legacy.entities?.media || []
  return mediaList.map((media, index) => {
    if (media.type === 'photo') {
      return {
        type: 'image',
        url: normalizeCapturedMediaUrl(media.media_url_https || media.media_url, 'image'),
        index,
      }
    }
    const variant = bestVideoVariant(media.video_info?.variants || [])
    if (variant?.url) {
      return {
        type: 'video',
        url: normalizeCapturedMediaUrl(variant.url, 'video'),
        index,
      }
    }
    return null
  }).filter((media) => media?.url && tweetId)
}

function collectTweetMedia(node, entries = new Map()) {
  if (!node || typeof node !== 'object') return entries

  const tweetId = String(node.rest_id || node.id_str || node.id || '')
  const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node
  const medias = mediaFromLegacyTweet(tweetId, legacy)
  if (tweetId && medias.length) {
    const old = entries.get(tweetId) || []
    const seen = new Set(old.map((media) => media.url))
    for (const media of medias) {
      if (!seen.has(media.url)) {
        old.push(media)
        seen.add(media.url)
      }
    }
    entries.set(tweetId, old)
  }

  if (Array.isArray(node)) {
    for (const item of node) collectTweetMedia(item, entries)
  } else {
    for (const value of Object.values(node)) collectTweetMedia(value, entries)
  }
  return entries
}

function installXMediaCaptureBridge() {
  if (!isXHost() || window.top !== window) return
  document.addEventListener('nekobooru:x-media-response', (event) => {
    const body = event?.detail?.body
    if (typeof body !== 'string' || !body) return
    try {
      const parsed = JSON.parse(body)
      const entries = [...collectTweetMedia(parsed).entries()].map(([tweetId, media]) => ({ tweetId, media }))
      if (!entries.length) return
      chrome.runtime.sendMessage({
        type: 'nekobooru-x-media-cache',
        entries,
      })
    } catch {
      // X response shapes change often; ignore unparseable captures.
    }
  })
}

function statusUrlFromStack(stack) {
  if (!isXHost()) return ''
  for (const el of stack) {
    const article = el?.closest?.('article[data-testid="tweet"]')
    const url = statusUrlFromArticle(article)
    if (url) return url
  }
  return ''
}

function normalizedXImageUrl(raw) {
  if (!raw) return ''
  try {
    const url = new URL(raw, location.origin)
    const host = url.hostname.toLowerCase()
    if (host !== 'pbs.twimg.com') return ''
    if (!url.pathname.includes('/media/')) return ''
    const inferredFormat = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
    if (!url.searchParams.has('format') && inferredFormat) url.searchParams.set('format', inferredFormat)
    if (url.searchParams.has('format')) url.searchParams.set('name', 'orig')
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

function imageUrlFromArticle(article) {
  return imageCandidateFromArticle(article)?.src || ''
}

function statusUrlForMediaElement(article, element) {
  const mediaLink = element?.closest?.('a[href*="/status/"]')
  const mediaStatusUrl = normalizedStatusUrl(mediaLink?.getAttribute('href') || mediaLink?.href || '')
  if (mediaStatusUrl) return withLocationMediaIndex(mediaStatusUrl)

  const nestedArticle = element?.closest?.('article[data-testid="tweet"]')
  const nestedStatusUrl = nestedArticle && nestedArticle !== article ? statusUrlFromArticle(nestedArticle) : ''
  return nestedStatusUrl || statusUrlFromArticle(article)
}

function imageCandidateFromArticle(article) {
  if (!article) return null
  const candidates = Array.from(article.querySelectorAll('img'))
    .map((img) => {
      const src = normalizedXImageUrl(img.currentSrc || img.src)
      if (!src) return null
      const area = (img.naturalWidth || img.clientWidth || 0) * (img.naturalHeight || img.clientHeight || 0)
      return { src, area, statusUrl: statusUrlForMediaElement(article, img) }
    })
    .filter(Boolean)
    .sort((a, b) => b.area - a.area)
  return candidates[0] || null
}

function videoCandidateFromArticle(article) {
  if (!article) return null
  const selectors = '[data-testid="videoPlayer"], [data-testid="playButton"], [data-testid="videoComponent"], video'
  const player = article.querySelector(selectors)
  if (!player) return null
  const statusUrl = statusUrlForMediaElement(article, player)
  return statusUrl ? { statusUrl } : null
}

function hasUploadableXMedia(article) {
  return Boolean(videoCandidateFromArticle(article) || imageCandidateFromArticle(article))
}

function uploadTargetFromArticle(article) {
  const statusUrl = statusUrlFromArticle(article)
  if (!statusUrl) return null

  const video = videoCandidateFromArticle(article)
  if (video) {
    return {
      src: video.statusUrl,
      page: video.statusUrl,
      mediaType: 'video',
      fetch: 'link',
      xTweetId: tweetIdFromUrl(video.statusUrl),
      xTweetUsername: tweetUsernameFromUrl(video.statusUrl),
    }
  }

  const image = imageCandidateFromArticle(article)
  if (image) {
    return {
      src: image.src,
      page: image.statusUrl || statusUrl,
      mediaType: 'image',
      fetch: 'direct',
      xTweetId: tweetIdFromUrl(image.statusUrl || statusUrl),
      xTweetUsername: tweetUsernameFromUrl(image.statusUrl || statusUrl),
      xMediaIndex: xMediaIndexFromUrl(image.statusUrl || statusUrl),
    }
  }

  return null
}

function installXButtonStyle() {
  if (document.getElementById('nekobooru-x-button-style')) return
  const style = document.createElement('style')
  style.id = 'nekobooru-x-button-style'
  style.textContent = `
    /* Match X's native action buttons: a 1.25em icon (== 18.75px at the 15px
       font base) centred in a ~34.75px round hit area, so our button is the
       same size and sits in line with reply/retweet/like/share. */
    .nekobooru-x-download {
      appearance: none;
      background: transparent;
      border: 0;
      border-radius: 999px;
      box-sizing: border-box;
      color: rgb(113, 118, 123);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      line-height: 1;
      height: 34.75px;
      width: 34.75px;
      min-width: 34.75px;
      margin-left: 12px;
      padding: 0;
      transition: background-color 120ms ease, color 120ms ease;
      vertical-align: middle;
    }
    .nekobooru-x-download-native-shell {
      align-items: center;
      display: inline-flex;
      justify-content: center;
    }
    .nekobooru-x-download-native-shell .nekobooru-x-download {
      margin-left: 0;
    }
    .nekobooru-x-download svg {
      display: block;
      height: 1.25em;
      width: 1.25em;
      stroke: currentColor;
    }
    .nekobooru-x-download:hover {
      background: rgba(29, 155, 240, 0.12);
      color: rgb(29, 155, 240);
    }
    /* The share action's slot can lay its children out stacked/wrapped; force a
       single inline row so our button sits to the right of the share icon. */
    .nekobooru-x-slot {
      display: flex !important;
      flex-direction: row !important;
      flex-wrap: nowrap !important;
      align-items: center !important;
      width: auto !important;
    }
  `
  document.documentElement.appendChild(style)
}

function nativeActionShell(actionGroup, innerButton) {
  const sampleButton = actionGroup.querySelector('[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [role="button"], button, a')
  if (!sampleButton) return innerButton

  let shell = sampleButton
  while (shell.parentElement && shell.parentElement !== actionGroup) {
    shell = shell.parentElement
  }
  if (!shell || shell === actionGroup) return innerButton

  const clonedShell = shell.cloneNode(false)
  clonedShell.classList.add('nekobooru-x-download-native-shell')
  clonedShell.removeAttribute('data-testid')
  clonedShell.removeAttribute('aria-label')
  clonedShell.removeAttribute('role')
  clonedShell.removeAttribute('tabindex')
  clonedShell.appendChild(innerButton)
  return clonedShell
}

function openUploadForTarget(target) {
  if (!target?.src) return
  try {
    const message = {
      type: 'nekobooru-open-upload',
      src: target.src,
      page: target.page || target.src,
      mediaType: target.mediaType || 'image',
      fetch: target.fetch || 'direct',
      xTweetId: target.xTweetId || tweetIdFromUrl(target.page || target.src),
      xTweetUsername: target.xTweetUsername || tweetUsernameFromUrl(target.page || target.src),
    }
    const xMediaIndex = Number.isInteger(target.xMediaIndex)
      ? target.xMediaIndex
      : xMediaIndexFromUrl(target.page || target.src)
    if (Number.isInteger(xMediaIndex)) message.xMediaIndex = xMediaIndex
    chrome.runtime.sendMessage(message)
  } catch {
    // Extension context may be reloading; ignore.
  }
}

function injectXButton(article) {
  if (!article) return
  const existing = article.querySelector('.nekobooru-x-download, .nekobooru-x-download-native-shell')
  const hasMedia = hasUploadableXMedia(article)
  if (existing && !hasMedia) existing.remove()
  if (existing || !hasMedia) return

  const actionGroups = Array.from(article.querySelectorAll('[role="group"]'))
  const actionGroup = actionGroups.find((group) => group.querySelector('[data-testid="reply"], [role="button"], button, a'))
  if (!actionGroup) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'nekobooru-x-download'
  button.title = 'Download to NekoBooru'
  button.setAttribute('aria-label', 'Download to NekoBooru')
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12.1 3.4v11.2m0 0-4.8-4.45m4.8 4.45 4.65-4.45"></path>
      <path d="M4.9 14.7v2.75c0 1.45 1.05 2.55 2.45 2.55h9.35c1.4 0 2.45-1.1 2.45-2.55V14.7"></path>
    </svg>
  `
  button.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const target = uploadTargetFromArticle(article)
    if (target) openUploadForTarget(target)
  })

  actionGroup.appendChild(nativeActionShell(actionGroup, button))
}

function scanXPosts(root = document) {
  if (!isXHost()) return
  installXButtonStyle()
  const article = root.matches?.('article[data-testid="tweet"]')
    ? root
    : root.closest?.('article[data-testid="tweet"]')
  if (article) injectXButton(article)
  root.querySelectorAll?.('article[data-testid="tweet"]').forEach(injectXButton)
}

function setupXPostButtons() {
  if (!isXHost() || window.top !== window) return

  const start = () => {
    scanXPosts()
    const target = document.body || document.documentElement
    if (!target) return
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scanXPosts(node)
        }
      }
    })
    observer.observe(target, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
}

// Listen on window in the capture phase so we run before the page's own handlers
// (capture order is window -> document -> ... -> target), letting us neutralise
// them before they can suppress the menu.
let lastContextMenuPoint = { x: 0, y: 0 }

function currentMediaAtLastContextMenu() {
  const stack = elementsUnder(lastContextMenuPoint.x, lastContextMenuPoint.y)
  return mediaFromStack(stack)
}

function filenameForCapturedFrame(media) {
  const raw = media?.currentSrc || media?.src || location.href
  try {
    const name = decodeURIComponent(new URL(raw, location.href).pathname.split('/').pop() || '')
    if (name) return name.replace(/\.[^.]+$/, '') + '-frame.png'
  } catch {
    // Use generic fallback.
  }
  return 'nekobooru-frame.png'
}

function captureRect(width, height, landscape = false) {
  if (!landscape) return { sx: 0, sy: 0, sw: width, sh: height, dw: width, dh: height }

  const targetAspect = 16 / 9
  const sourceAspect = width / height
  let sx = 0
  let sy = 0
  let sw = width
  let sh = height

  if (sourceAspect < targetAspect) {
    sh = Math.round(width / targetAspect)
    sy = Math.max(0, Math.round((height - sh) / 2))
  } else if (sourceAspect > targetAspect) {
    sw = Math.round(height * targetAspect)
    sx = Math.max(0, Math.round((width - sw) / 2))
  }

  return { sx, sy, sw, sh, dw: sw, dh: sh }
}

function captureCurrentMediaFrame(options = {}) {
  const media = currentMediaAtLastContextMenu()
  if (!media) return { ok: false, error: 'No image or video was found under the last right-click.' }

  const width = media.tagName === 'VIDEO' ? media.videoWidth : media.naturalWidth
  const height = media.tagName === 'VIDEO' ? media.videoHeight : media.naturalHeight
  if (!width || !height) return { ok: false, error: 'The media frame is not ready yet.' }

  try {
    const rect = captureRect(width, height, !!options.landscape)
    const canvas = document.createElement('canvas')
    canvas.width = rect.dw
    canvas.height = rect.dh
    const context = canvas.getContext('2d')
    if (!context) return { ok: false, error: 'Canvas capture is unavailable.' }
    context.drawImage(media, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.dw, rect.dh)
    return {
      ok: true,
      dataUrl: canvas.toDataURL('image/png'),
      filename: filenameForCapturedFrame(media),
    }
  } catch (e) {
    return {
      ok: false,
      error: 'This site blocks frame capture for cross-origin media. Open a reverse-search site and upload/download the frame manually.',
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'nekobooru-capture-current-frame') return
  sendResponse(captureCurrentMediaFrame({ landscape: !!msg.landscape }))
})

window.addEventListener(
  'contextmenu',
  (e) => {
    lastContextMenuPoint = { x: e.clientX, y: e.clientY }
    const editableTarget = editableTargetFromEvent(e)
    if (editableTarget) lastEditableTarget = editableTarget

    const stack = elementsUnder(e.clientX, e.clientY)
    const media = mediaFromStack(stack)
    const hasVideo = media?.tagName === 'VIDEO' || stack.some((el) => el.tagName === 'VIDEO')
    const hasMedia = !!media
    const postUrl = statusUrlFromStack(stack)

    // Report the cursor (for popup placement) and whether a video is under it
    // (so the download item can route to yt-dlp even over a poster/overlay).
    try {
      chrome.runtime.sendMessage({
        type: 'nekobooru-cursor',
        x: e.screenX,
        y: e.screenY,
        hasVideo,
        mediaUrl: mediaUrlFromElement(media),
        mediaType: media?.tagName === 'VIDEO' ? 'video' : media?.tagName === 'IMG' ? 'image' : '',
        postUrl,
      })
    } catch {
      // Extension context may be reloading; ignore.
    }

    // Over media: block the page's contextmenu handlers (so they can't
    // preventDefault or pop a custom menu) and let the native menu through.
    // We deliberately do NOT call preventDefault ourselves.
    if (hasMedia) e.stopImmediatePropagation()
  },
  true,
)

setupXPostButtons()
installXMediaCaptureBridge()
