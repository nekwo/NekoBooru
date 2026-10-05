// trace.moe: a "Download to NekoBooru" button beside the result player's Share
// button. The site has no per-result page or REST route to point at - the only
// handle on a match is the scene clip the player is showing, a plain mp4 at
// api.trace.moe/video/<token>. The player is buried under overlay divs, so a
// right-click never lands on the <video>; the button is the reliable route.
//
// The player also names the release file the match came from, which usually
// carries the show, season and episode. That and the clip's scene timestamps
// ride along to the popup, which saves them as the post's semantic description.

(() => {
  const BUTTON_CLASS = 'nekobooru-trace-download'

  // ?size=l is the largest clip trace.moe serves; the player may show s/m.
  function traceVideoUrl(raw) {
    if (!raw) return ''
    try {
      const url = new URL(raw, location.href)
      if (url.hostname !== 'api.trace.moe' || !url.pathname.startsWith('/video/')) return ''
      url.searchParams.set('size', 'l')
      url.searchParams.delete('mute')
      url.hash = ''
      return url.href
    } catch {
      return ''
    }
  }

  function playerVideo() {
    return document.querySelector('video[src*="api.trace.moe/video/"]')
  }

  // trace.moe itself is stateless, so its address bar is no use as a source.
  // The info pane links the matched show on AniList; fall back to the clip.
  function sourcePageUrl(videoUrl) {
    const anilist = document.querySelector('[class*="__infoPane"] a[href*="anilist.co/anime/"]')
      || document.querySelector('a[href*="anilist.co/anime/"]')
    return anilist?.href || videoUrl
  }

  // The clip's own headers say where in the episode the scene sits; the
  // player's on-screen clock only shows wherever the loop happens to be.
  async function sceneTimes(src) {
    try {
      const res = await fetch(src, { method: 'HEAD' })
      const read = (name) => {
        const value = Number.parseFloat(res.headers.get(name) || '')
        return Number.isFinite(value) ? value : null
      }
      return { start: read('x-video-start'), end: read('x-video-end'), duration: read('x-video-duration') }
    } catch {
      return {}
    }
  }

  async function sceneMetadata(src) {
    const filename = document.querySelector('[class*="__fileNameDisplay"]')?.textContent?.trim() || ''
    const meta = { ...parseTraceMoeFilename(filename), ...(await sceneTimes(src)) }
    const seriesTitles = [...infoPaneTitles(), meta.title].filter(Boolean)
    return { ...meta, ...traceMoeSceneDescription(meta), seriesTitles }
  }

  // The matched show's names as the info pane lists them: the heading (native
  // title), the romaji line under it, then every line of the "Alias" row.
  function infoPaneTitles() {
    const pane = document.querySelector('[class*="__infoPane"]')
    if (!pane) return []
    const lines = (el) => (el?.innerText || el?.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean)
    const titles = []
    pane.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => titles.push(...lines(heading)))
    const aliasLabel = Array.from(pane.querySelectorAll('td, th, dt, div, span'))
      .find((el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === 'alias')
    const aliasCell = aliasLabel?.nextElementSibling || aliasLabel?.parentElement?.nextElementSibling
    titles.push(...lines(aliasCell))
    return titles.slice(0, 12)
  }

  function shareControl(actionBar) {
    return Array.from(actionBar.querySelectorAll('button, a, [role="button"]'))
      .find((el) => /\bshare\b/i.test(el.textContent || '')) || null
  }

  async function openUpload() {
    const src = traceVideoUrl(playerVideo()?.currentSrc || playerVideo()?.src || '')
    if (!src) return
    const traceMoe = await sceneMetadata(src)
    try {
      chrome.runtime.sendMessage({
        type: 'nekobooru-open-upload',
        src,
        page: sourcePageUrl(src),
        mediaType: 'video',
        fetch: 'direct',
        traceMoe,
      })
    } catch {
      // Extension context may be reloading; ignore.
    }
  }

  function injectButton() {
    const actionBar = document.querySelector('[class*="__actionBar"]')
    if (!actionBar || actionBar.querySelector('.' + BUTTON_CLASS)) return
    const share = shareControl(actionBar)
    const button = document.createElement('button')
    button.type = 'button'
    // Borrow Share's (hashed CSS-module) classes so it matches the native control.
    button.className = `${share?.className || ''} ${BUTTON_CLASS}`.trim()
    button.title = 'Download this scene to NekoBooru'
    button.style.marginLeft = '8px'
    button.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px">
        <path d="M12.1 3.4v11.2m0 0-4.8-4.45m4.8 4.45 4.65-4.45"></path>
        <path d="M4.9 14.7v2.75c0 1.45 1.05 2.55 2.45 2.55h9.35c1.4 0 2.45-1.1 2.45-2.55V14.7"></path>
      </svg>NekoBooru`
    button.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openUpload()
    })
    if (share) share.after(button)
    else actionBar.appendChild(button)
  }

  // Next.js swaps the result pane in and out as results are picked, so keep
  // re-checking rather than injecting once.
  const start = () => {
    injectButton()
    new MutationObserver(injectButton).observe(document.body, { childList: true, subtree: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
