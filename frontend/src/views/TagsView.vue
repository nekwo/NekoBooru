<template>
  <div class="tags-view">
    <div class="header">
      <h1>Tags</h1>
      <input
        type="text"
        v-model="searchQuery"
        placeholder="Search tags~ nyaa"
        @input="debouncedSearch"
      />
    </div>

    <p v-if="notice" class="tags-notice">{{ notice }}</p>

    <div class="tags-table-container">
      <table class="tags-table">
        <thead>
          <tr>
            <th @click="sortBy('name')" class="sortable">
              Name {{ sortKey === 'name' ? (sortAsc ? '&#9650;' : '&#9660;') : '' }}
            </th>
            <th>Category</th>
            <th @click="sortBy('usage')" class="sortable">
              Posts {{ sortKey === 'usage' ? (sortAsc ? '&#9650;' : '&#9660;') : '' }}
            </th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tag in tags" :key="tag.id">
            <td>
              <TagSearchMenu
                :tag="tag.name"
                :label="tag.name"
                :display-name="tag.displayName"
                :sankaku-name="tag.sankakuName || ''"
                trigger-class="tag-link"
              />
            </td>
            <td>
              <select
                :value="tag.category"
                @change="updateCategory(tag, $event.target.value)"
                :style="{ borderLeftColor: tag.categoryColor }"
                class="category-select"
              >
                <option v-for="cat in categories" :key="cat.id" :value="cat.name">
                  {{ cat.name }}
                </option>
              </select>
            </td>
            <td>{{ tag.usageCount }}</td>
            <td class="tag-actions">
              <form v-if="aliasingTagId === tag.id" class="alias-row-form" @submit.prevent="aliasRowTag(tag)">
                <TagNameInput
                  ref="aliasTargetInput"
                  v-model="aliasTarget"
                  :exclude="tag.name"
                  placeholder="Canonical tag, e.g. honoka_(doa)"
                  @keydown.esc="cancelAliasing"
                />
                <button class="btn btn-sm" type="submit" :disabled="!aliasTarget.trim() || aliasSaving">
                  {{ aliasSaving ? 'Merging...' : 'Merge' }}
                </button>
                <button class="btn btn-secondary btn-sm" type="button" @click="cancelAliasing">Cancel</button>
              </form>
              <template v-else>
                <button
                  class="btn btn-secondary btn-sm"
                  title="Merge this tag's posts into another tag and keep this name as an alias of it"
                  @click="startAliasing(tag)"
                >
                  Alias of&hellip;
                </button>
                <a
                  class="btn btn-secondary btn-sm"
                  :href="sankakuTagUrl(tag)"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Search Sankaku Channel for this tag"
                  @click="searchSankaku($event, tag)"
                >
                  Open in Sankaku
                </a>
                <button class="btn btn-secondary btn-sm" @click="deleteTag(tag)">
                  Delete
                </button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Pagination v-model="page" :pages="pages" @update:modelValue="fetchTags" />

    <div class="implications-section">
      <h2>Tag Implications</h2>
      <p class="hint">When tag A implies tag B, adding A will automatically add B</p>

      <div class="add-form">
        <input v-model="newImplication.antecedent" placeholder="Source tag" />
        <span>implies</span>
        <input v-model="newImplication.consequent" placeholder="Target tag" />
        <button class="btn" @click="addImplication">Add</button>
      </div>

      <div class="implications-list">
        <div v-for="impl in implications" :key="impl.id" class="implication-item">
          <span>{{ impl.antecedent }}</span>
          <span class="arrow">&#8594;</span>
          <span>{{ impl.consequent }}</span>
          <button class="delete-btn" @click="deleteImplication(impl.id)">&times;</button>
        </div>
      </div>
    </div>

    <div class="aliases-section">
      <h2>Tag Aliases</h2>
      <p class="hint">
        Aliases redirect to canonical tags. Aliasing a tag that already exists merges its posts into the
        canonical one; a canonical tag that does not exist yet is created by renaming it.
      </p>

      <div class="add-form">
        <input v-model="newAlias.alias" placeholder="Alias" />
        <span>points to</span>
        <TagNameInput v-model="newAlias.target" placeholder="Canonical tag" />
        <button class="btn" @click="addAlias">Add</button>
      </div>

      <div class="aliases-list">
        <div v-for="alias in aliases" :key="alias.id" class="alias-item">
          <span>{{ alias.aliasName }}</span>
          <span class="arrow">&#8594;</span>
          <span>{{ alias.targetName }}</span>
          <button class="delete-btn" @click="deleteAlias(alias.id)">&times;</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../api/client'
import Pagination from '../components/Pagination.vue'
import TagNameInput from '../components/TagNameInput.vue'
import TagSearchMenu from '../components/TagSearchMenu.vue'
import { sankakuFallbackUrl, openSankakuSearch } from '../utils/sankakuSearch.js'

const route = useRoute()
const router = useRouter()

const tags = ref([])
const categories = ref([])
const total = ref(0)
const page = ref(1)
const limit = 50
// Seeded from ?q= so arriving from a tag's "?" link lands on that tag instead
// of the full list with the name still to be typed again.
const searchQuery = ref(String(route.query.q || ''))
const sortKey = ref('usage')
const sortAsc = ref(false)

const implications = ref([])
const newImplication = ref({ antecedent: '', consequent: '' })

const aliases = ref([])
const newAlias = ref({ alias: '', target: '' })

// The row whose "Alias of..." form is open, and what was typed into it.
const aliasingTagId = ref(null)
const aliasTarget = ref('')
const aliasTargetInput = ref(null)
const aliasSaving = ref(false)
const notice = ref('')

const pages = computed(() => Math.ceil(total.value / limit))

let debounceTimer = null

onMounted(async () => {
  await Promise.all([
    fetchTags(),
    fetchCategories(),
    fetchImplications(),
    fetchAliases(),
  ])
})

// Following another tag's "?" while already here only changes the query, so
// the component is reused and nothing would refetch without this.
watch(
  () => route.query.q,
  (value) => {
    const next = String(value || '')
    if (next === searchQuery.value) return
    searchQuery.value = next
    page.value = 1
    fetchTags()
  },
)

async function fetchTags() {
  try {
    const result = await api.getTags({
      q: searchQuery.value,
      page: page.value,
      limit,
      sort: sortKey.value,
      order: sortAsc.value ? 'asc' : 'desc',
    })
    tags.value = result.results
    total.value = result.total
  } catch (e) {
    console.error('Failed to fetch tags:', e)
  }
}

async function fetchCategories() {
  try {
    categories.value = await api.getCategories()
  } catch (e) {
    console.error('Failed to fetch categories:', e)
  }
}

async function fetchImplications() {
  try {
    implications.value = await api.getImplications()
  } catch (e) {
    console.error('Failed to fetch implications:', e)
  }
}

async function fetchAliases() {
  try {
    aliases.value = await api.getAliases()
  } catch (e) {
    console.error('Failed to fetch aliases:', e)
  }
}

function debouncedSearch() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    page.value = 1
    // Keep the URL honest so a reload or a shared link shows the same list.
    // replace(), not push(), so typing does not bury the back button.
    const q = searchQuery.value || undefined
    if (String(route.query.q || '') !== String(q || '')) {
      router.replace({ path: '/tags', query: { ...route.query, q } })
    }
    fetchTags()
  }, 300)
}

function sortBy(key) {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value
  } else {
    sortKey.value = key
    sortAsc.value = false
  }
  fetchTags()
}

async function updateCategory(tag, category) {
  try {
    await api.updateTag(tag.name, { category })
    tag.category = category
    const cat = categories.value.find(c => c.name === category)
    if (cat) tag.categoryColor = cat.color
  } catch (e) {
    alert('Failed to update tag: ' + e.message)
  }
}

async function deleteTag(tag) {
  if (!confirm(`Delete tag "${tag.name}"? This will remove it from all posts.`)) return
  try {
    await api.deleteTag(tag.name)
    tags.value = tags.value.filter(t => t.id !== tag.id)
  } catch (e) {
    alert('Failed to delete tag: ' + e.message)
  }
}

async function addImplication() {
  if (!newImplication.value.antecedent || !newImplication.value.consequent) return
  try {
    const impl = await api.createImplication(newImplication.value)
    implications.value.push(impl)
    newImplication.value = { antecedent: '', consequent: '' }
  } catch (e) {
    alert('Failed to add implication: ' + e.message)
  }
}

async function deleteImplication(id) {
  try {
    await api.deleteImplication(id)
    implications.value = implications.value.filter(i => i.id !== id)
  } catch (e) {
    alert('Failed to delete implication: ' + e.message)
  }
}

async function addAlias() {
  if (!newAlias.value.alias || !newAlias.value.target) return
  try {
    const alias = await api.createAlias(newAlias.value)
    aliases.value.push(alias)
    newAlias.value = { alias: '', target: '' }
    showAliasNotice(alias)
    // Aliasing an existing tag merges it away; the list has to catch up.
    await fetchTags()
  } catch (e) {
    alert('Failed to add alias: ' + e.message)
  }
}

// Sankaku's own name when it spells the tag differently (honoka_doa is
// honoka_(dead_or_alive) there), else the booru spelling the display name
// still carries - Sankaku needs the parentheses the stored name lost. A tag
// without a Sankaku name is looked up when clicked.
function sankakuTagUrl(tag) {
  return sankakuFallbackUrl(tag)
}

async function searchSankaku(event, tag) {
  const name = await openSankakuSearch(event, tag)
  if (name && !tag.sankakuName) tag.sankakuName = name
}

async function startAliasing(tag) {
  aliasingTagId.value = tag.id
  aliasTarget.value = ''
  await nextTick()
  const input = Array.isArray(aliasTargetInput.value) ? aliasTargetInput.value[0] : aliasTargetInput.value
  input?.focus()
}

function cancelAliasing() {
  aliasingTagId.value = null
  aliasTarget.value = ''
}

async function aliasRowTag(tag) {
  const target = aliasTarget.value.trim()
  if (!target || aliasSaving.value) return
  aliasSaving.value = true
  try {
    const alias = await api.createAlias({ alias: tag.name, target })
    aliases.value.push(alias)
    cancelAliasing()
    showAliasNotice(alias)
    await fetchTags()
  } catch (e) {
    alert('Failed to alias tag: ' + e.message)
  } finally {
    aliasSaving.value = false
  }
}

function showAliasNotice(alias) {
  if (alias.renamed) {
    notice.value = `Renamed ${alias.aliasName} to ${alias.targetName}; the old name is now an alias.`
  } else if (alias.mergedPosts) {
    const posts = `${alias.mergedPosts} post${alias.mergedPosts === 1 ? '' : 's'}`
    notice.value = `Merged ${posts} from ${alias.aliasName} into ${alias.targetName}; the old name is now an alias.`
  } else {
    notice.value = `${alias.aliasName} is now an alias of ${alias.targetName}.`
  }
}

async function deleteAlias(id) {
  try {
    await api.deleteAlias(id)
    aliases.value = aliases.value.filter(a => a.id !== id)
  } catch (e) {
    alert('Failed to delete alias: ' + e.message)
  }
}
</script>

<style scoped>
.tags-view {
  max-width: 1000px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.header input {
  width: 250px;
}

.tags-table-container {
  overflow-x: auto;
}

.tags-table {
  width: 100%;
  border-collapse: collapse;
  color: var(--text-primary);
}

.tags-table th,
.tags-table td {
  padding: 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  color: var(--text-primary);
}

.tags-table th {
  background: var(--bg-secondary);
  font-weight: 600;
}

.tags-table th.sortable {
  cursor: pointer;
}

.tags-table th.sortable:hover {
  background: var(--bg-tertiary);
}

.tags-table :deep(.tag-link) {
  font-weight: 500;
}

.tags-notice {
  margin-bottom: 1rem;
  padding: 0.6rem 0.8rem;
  border-radius: 0.375rem;
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.tag-actions {
  white-space: nowrap;
}

.tag-actions > .btn + .btn {
  margin-left: 0.4rem;
}

.alias-row-form {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.alias-row-form :deep(.tag-name-input) {
  width: 240px;
}

.category-select {
  border-left: 3px solid;
  padding-left: 0.5rem;
}

.implications-section,
.aliases-section {
  margin-top: 3rem;
}

.implications-section h2,
.aliases-section h2 {
  margin-bottom: 0.5rem;
}

.hint {
  color: var(--text-secondary);
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

.add-form {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
}

.add-form input,
.add-form :deep(.tag-name-input) {
  width: 200px;
}

.implications-list,
.aliases-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.implication-item,
.alias-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-secondary);
  border-radius: 0.25rem;
  color: var(--text-primary);
}

.arrow {
  color: var(--text-secondary);
}

.delete-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: #ef4444;
  font-size: 1.25rem;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
</style>
