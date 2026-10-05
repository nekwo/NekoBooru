import { describe, expect, it, vi } from 'vitest'
import { SEARCH_PROVIDERS, detectExtension, openSearchTarget, requestExtensionReverseSearch } from './onlineImageSearch'

describe('online image search helpers', () => {
  it('opens a named target before preparing an upload', () => {
    const target = { document: { title: '', body: { textContent: '' } } }
    const openWindow = vi.fn(() => target)
    const result = openSearchTarget('google', openWindow)
    expect(openWindow).toHaveBeenCalledWith('', result.targetName)
    expect(target.document.body.textContent).toBe('Preparing image search...')
  })

  it('resolves when the extension acknowledges the full-stack request', async () => {
    const listeners = new Set()
    const windowRef = {
      location: { origin: 'http://localhost:5173' },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: vi.fn((request) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              source: windowRef,
              origin: windowRef.location.origin,
              data: {
                type: 'nekobooru-reverse-search-result',
                requestId: request.requestId,
                ok: true,
              },
            })
          }
        })
      }),
    }
    await expect(requestExtensionReverseSearch(
      { mediaUrl: 'http://localhost:5173/media.png' },
      { windowRef, timeoutMs: 50 },
    )).resolves.toMatchObject({ ok: true })
  })

  it('reports the extension only when its content script answers', async () => {
    const listeners = new Set()
    const windowRef = {
      location: { origin: 'http://localhost:8772' },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      postMessage: vi.fn(),
    }
    await expect(detectExtension({ windowRef, timeoutMs: 20 })).resolves.toBe(false)

    windowRef.postMessage = vi.fn((request) => queueMicrotask(() => {
      for (const listener of listeners) {
        listener({
          source: windowRef,
          origin: windowRef.location.origin,
          data: { type: 'nekobooru-extension-pong', requestId: request.requestId, reverseSearch: true },
        })
      }
    }))
    await expect(detectExtension({ windowRef, timeoutMs: 50 })).resolves.toBe(true)
  })

  it('offers every provider, with only the form-upload ones usable without the extension', () => {
    expect(SEARCH_PROVIDERS.map((provider) => provider.id)).toEqual(['saucenao', 'iqdb', 'google', 'tineye', 'trace'])
    expect(SEARCH_PROVIDERS.filter((provider) => provider.direct).map((provider) => provider.id)).toEqual(['saucenao', 'iqdb'])
  })
})
