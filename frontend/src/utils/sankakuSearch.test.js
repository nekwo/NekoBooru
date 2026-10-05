// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({ default: {} }))

import { openSankakuSearch, sankakuFallbackUrl } from './sankakuSearch.js'

const honoka = { name: 'honoka_doa', displayName: 'honoka (doa)' }
const leftClick = () => ({ button: 0, preventDefault: vi.fn() })

describe('sankakuFallbackUrl', () => {
  it('uses the stored Sankaku name, else the booru spelling', () => {
    expect(sankakuFallbackUrl({ ...honoka, sankakuName: 'honoka_(dead_or_alive)' })).toBe(
      'https://chan.sankakucomplex.com/?tags=honoka_(dead_or_alive)',
    )
    expect(sankakuFallbackUrl(honoka)).toBe('https://chan.sankakucomplex.com/?tags=honoka_(doa)')
  })
})

describe('openSankakuSearch', () => {
  it('looks the name up on a plain click and points the new tab at it', async () => {
    const tab = { location: { href: '' }, opener: 'page' }
    const openWindow = vi.fn(() => tab)
    const resolveName = vi.fn(async () => ({ sankakuName: 'honoka_(dead_or_alive)', found: true }))
    const event = leftClick()

    const name = await openSankakuSearch(event, honoka, 'https://sankaku.app', { openWindow, resolveName })

    expect(event.preventDefault).toHaveBeenCalled()
    expect(resolveName).toHaveBeenCalledWith('honoka_doa')
    expect(openWindow).toHaveBeenCalledWith('about:blank')
    expect(tab.location.href).toBe('https://sankaku.app/?tags=honoka_(dead_or_alive)')
    expect(tab.opener).toBe(null)
    expect(name).toBe('honoka_(dead_or_alive)')
  })

  it('falls back to the booru spelling when the lookup fails', async () => {
    const tab = { location: { href: '' } }
    const name = await openSankakuSearch(leftClick(), honoka, undefined, {
      openWindow: () => tab,
      resolveName: async () => { throw new Error('offline') },
    })
    expect(tab.location.href).toBe('https://chan.sankakucomplex.com/?tags=honoka_(doa)')
    expect(name).toBe('honoka_(doa)')
  })

  it('leaves known names and middle or modified clicks to the link itself', async () => {
    const resolveName = vi.fn()
    const known = await openSankakuSearch(leftClick(), { ...honoka, sankakuName: 'x_(y)' }, undefined, { resolveName })
    const middle = { button: 1, preventDefault: vi.fn() }
    await openSankakuSearch(middle, honoka, undefined, { resolveName })
    const ctrl = { button: 0, ctrlKey: true, preventDefault: vi.fn() }
    await openSankakuSearch(ctrl, honoka, undefined, { resolveName })

    expect(known).toBe('x_(y)')
    expect(resolveName).not.toHaveBeenCalled()
    expect(middle.preventDefault).not.toHaveBeenCalled()
    expect(ctrl.preventDefault).not.toHaveBeenCalled()
  })
})
