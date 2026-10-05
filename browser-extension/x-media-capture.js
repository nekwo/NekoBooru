// Runs in the page's MAIN world on X/Twitter. It observes the same API
// responses the page receives after authenticating normally, then forwards the
// response body to the isolated content script for parsing/caching.

(() => {
  // Any GraphQL operation, plus the REST endpoints that carry direct messages.
  // This used to name the fourteen operations known to return tweets, which
  // fails silently in both directions: X renames and adds operations without
  // notice, and a miss just leaves the media cache empty, so the download falls
  // through to yt-dlp with nothing to say for itself. A body holding no media
  // costs one walk and is dropped, which is cheaper than tracking X's current
  // operation names.
  const CAPTURE_ENDPOINT = /^(?:\/i\/api)?(?:\/graphql\/[^/]+\/[A-Za-z0-9_-]+|\/1\.1\/dm\/[^?#]+)$/
  // Big enough for a full timeline page; a body past it is not a media payload.
  const MAX_BODY_BYTES = 12 * 1024 * 1024
  const EVENT_NAME = 'nekobooru:x-media-response'

  function toUrl(raw) {
    try {
      return raw instanceof URL ? raw : new URL(raw, location.origin)
    } catch {
      return null
    }
  }

  function emitBody(rawUrl, status, body) {
    if (status !== 200 || typeof body !== 'string' || !body) return
    if (body.length > MAX_BODY_BYTES) return
    const url = toUrl(rawUrl)
    if (!url || !CAPTURE_ENDPOINT.test(url.pathname)) return
    document.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: {
        path: url.pathname,
        body,
      },
    }))
  }

  function emitXhrResponse(xhr) {
    emitBody(xhr.responseURL, xhr.status, xhr.responseText)
  }

  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = new Proxy(originalOpen, {
    apply(target, xhr, args) {
      const url = toUrl(args[1])
      if (url && CAPTURE_ENDPOINT.test(url.pathname)) {
        xhr.addEventListener('load', () => emitXhrResponse(xhr))
      }
      return Reflect.apply(target, xhr, args)
    },
  })

  // X has moved most timeline/tweet requests from XHR to fetch. Clone the
  // response so inspecting it does not consume the stream the page is using.
  // Cache capture runs in parallel and never delays X's own response handling.
  const originalFetch = window.fetch
  window.fetch = new Proxy(originalFetch, {
    async apply(target, thisArg, args) {
      const response = await Reflect.apply(target, thisArg, args)
      const requestUrl = args[0] instanceof Request ? args[0].url : args[0]
      const url = toUrl(response.url || requestUrl)
      if (response.status === 200 && url && CAPTURE_ENDPOINT.test(url.pathname)) {
        response.clone().text()
          .then((body) => emitBody(url, response.status, body))
          .catch(() => {})
      }
      return response
    },
  })
})()
