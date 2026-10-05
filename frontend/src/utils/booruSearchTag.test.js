import { describe, expect, it } from 'vitest'

import { SANKAKU_APP, booruSearchTag, normalizeTagName, sankakuSearchUrl } from './booruSearchTag.js'

describe('booruSearchTag', () => {
  it('restores punctuation the stored name flattened away', () => {
    expect(booruSearchTag('seitokai_ni_mo_ana_wa_aru', 'seitokai ni mo ana wa aru!')).toBe('seitokai_ni_mo_ana_wa_aru!')
    expect(booruSearchTag('miyu_blue_archive', 'miyu (blue archive)')).toBe('miyu_(blue_archive)')
    expect(booruSearchTag('k-on', 'K-ON!')).toBe('k-on!')
  })

  it('keeps the stored name when the display name says something else', () => {
    expect(booruSearchTag('blue_hair', 'Blue hair (long)')).toBe('blue_hair')
    expect(booruSearchTag('blue_hair', '')).toBe('blue_hair')
    expect(booruSearchTag('blue_hair', 'blue hair')).toBe('blue_hair')
  })

  it('flattens names the same way the backend does', () => {
    expect(normalizeTagName('Seitokai ni mo Ana wa Aru!')).toBe('seitokai_ni_mo_ana_wa_aru')
    expect(normalizeTagName('miyu_(blue_archive)')).toBe('miyu_blue_archive')
    expect(normalizeTagName('rating:safe')).toBe('rating:safe')
  })
})

describe('sankakuSearchUrl', () => {
  it('searches classic Sankaku Channel by default, sankaku.app on request', () => {
    expect(sankakuSearchUrl('honoka_(dead_or_alive)')).toBe('https://chan.sankakucomplex.com/?tags=honoka_(dead_or_alive)')
    expect(sankakuSearchUrl('blue hair', SANKAKU_APP)).toBe('https://sankaku.app/?tags=blue%20hair')
  })
})
