// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const api = vi.hoisted(() => ({ autocomplete: vi.fn() }))
vi.mock('../api/client', () => ({ default: api }))

import TagNameInput from './TagNameInput.vue'

let wrapper

afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function typeInto(value) {
  vi.useFakeTimers()
  wrapper = mount(TagNameInput, {
    attachTo: document.body,
    props: { modelValue: '', exclude: 'honoka_dead_or_alive', 'onUpdate:modelValue': (next) => wrapper.setProps({ modelValue: next }) },
  })
  await wrapper.find('input').setValue(value)
  vi.advanceTimersByTime(300)
  await flushPromises()
  return wrapper
}

describe('TagNameInput', () => {
  it('always asks the boorus and offers their spelling, minus the excluded tag', async () => {
    api.autocomplete.mockResolvedValue([
      { name: 'honoka_dead_or_alive', displayName: 'honoka (dead or alive)', category: 'character', usageCount: 0 },
      { name: 'honoka_doa', displayName: 'honoka (doa)', category: 'character', remote: true, source: 'danbooru', remoteCount: 822 },
    ])
    const view = await typeInto('honoka')

    expect(api.autocomplete).toHaveBeenCalledWith('honoka', { includeRemote: true, forceRemote: true })
    const rows = view.findAll('li')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('honoka_(doa)')
    expect(rows[0].text()).toContain('danbooru 822')

    await rows[0].trigger('mousedown')
    expect(view.props('modelValue')).toBe('honoka_(doa)')
    expect(view.findAll('li')).toHaveLength(0)
  })

  it('picks the highlighted row on Enter, and otherwise leaves Enter to the form', async () => {
    api.autocomplete.mockResolvedValue([
      { name: 'special_week_umamusume', displayName: 'special week (umamusume)', category: 'character', usageCount: 5 },
    ])
    const view = await typeInto('special')
    const input = view.find('input')

    const plain = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    input.element.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)

    await input.trigger('keydown', { key: 'ArrowDown' })
    const picked = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    input.element.dispatchEvent(picked)
    await flushPromises()
    expect(picked.defaultPrevented).toBe(true)
    expect(view.props('modelValue')).toBe('special_week_(umamusume)')
  })
})
