// SauceNAO: its Sankaku results still link the old numeric post pages
// (chan.sankakucomplex.com/post/show/<id>), which now 404. Point them at the
// posts/similar page that still resolves a numeric ID. Hidden low-similarity
// results are revealed later by the page's own script, so keep watching.

;(() => {
  const core = globalThis.NekoBooruSiteImport
  if (!core) return

  function fixLinks() {
    document.querySelectorAll('a[href*="sankakucomplex.com"]').forEach((anchor) => {
      const fixed = core.sankakuLegacyPostUrl(anchor.href)
      if (fixed && anchor.href !== fixed) anchor.href = fixed
    })
  }

  fixLinks()
  new MutationObserver(fixLinks).observe(document.documentElement, { childList: true, subtree: true })
})()
