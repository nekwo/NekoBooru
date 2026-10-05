// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  getTags: vi.fn(),
  getCategories: vi.fn(),
  getImplications: vi.fn(),
  getAliases: vi.fn(),
  createAlias: vi.fn(),
}))

vi.mock('../api/client', () => ({ default: api }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn() }),
}))

import TagsView from './TagsView.vue'

const honoka = {
  id: 7,
  name: 'honoka_dead_or_alive',
  displayName: 'honoka (dead or alive)',
  category: 'character',
  categoryColor: '#0a0',
  usageCount: 1,
}

let wrapper

beforeEach(() => {
  api.getTags.mockResolvedValue({ results: [honoka], total: 1 })
  api.getCategories.mockResolvedValue([{ id: 4, name: 'character', color: '#0a0' }])
  api.getImplications.mockResolvedValue([])
  api.getAliases.mockResolvedValue([])
})

afterEach(() => {
  wrapper?.unmount()
  vi.clearAllMocks()
})

async function mountView() {
  wrapper = mount(TagsView, {
    global: { stubs: { TagSearchMenu: true, Pagination: true } },
  })
  await flushPromises()
  return wrapper
}

describe('TagsView row actions', () => {
  it('opens the tag on Sankaku with the booru spelling', async () => {
    const view = await mountView()
    const link = view.findAll('a').find((node) => node.text() === 'Open in Sankaku')
    expect(link.attributes('href')).toBe('https://chan.sankakucomplex.com/?tags=honoka_(dead_or_alive)')
    expect(link.attributes('target')).toBe('_blank')
  })

  it("prefers the tag's stored Sankaku name for the Sankaku search", async () => {
    api.getTags.mockResolvedValue({
      results: [{ ...honoka, id: 8, name: 'honoka_doa', displayName: 'honoka (doa)', sankakuName: 'honoka_(dead_or_alive)' }],
      total: 1,
    })
    const view = await mountView()
    const link = view.findAll('a').find((node) => node.text() === 'Open in Sankaku')
    expect(link.attributes('href')).toBe('https://chan.sankakucomplex.com/?tags=honoka_(dead_or_alive)')
  })

  it('aliases the row tag into the typed canonical tag and refreshes', async () => {
    api.createAlias.mockResolvedValue({
      id: 1,
      aliasName: 'honoka_dead_or_alive',
      targetName: 'honoka_doa',
      mergedPosts: 1,
      renamed: false,
    })
    const view = await mountView()
    await view.findAll('button').find((node) => node.text().startsWith('Alias of')).trigger('click')
    await view.find('.alias-row-form input').setValue('honoka_(doa)')
    await view.find('.alias-row-form').trigger('submit')
    await flushPromises()

    expect(api.createAlias).toHaveBeenCalledWith({ alias: 'honoka_dead_or_alive', target: 'honoka_(doa)' })
    expect(api.getTags).toHaveBeenCalledTimes(2)
    expect(view.find('.tags-notice').text()).toBe(
      'Merged 1 post from honoka_dead_or_alive into honoka_doa; the old name is now an alias.',
    )
    expect(view.find('.alias-row-form').exists()).toBe(false)
  })
})
