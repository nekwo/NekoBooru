<template>
  <div class="tag-name-input">
    <input
      ref="input"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      autocomplete="off"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="suggestions.length > 0 ? 'true' : 'false'"
      @input="onInput($event.target.value)"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter="onEnter"
      @keydown.esc="onEscape"
      @blur="onBlur"
    />
    <ul v-if="suggestions.length > 0" class="suggestions" role="listbox" :style="listStyle">
      <li
        v-for="(tag, index) in suggestions"
        :key="`${tag.remote ? 'remote' : 'local'}:${tag.name}`"
        role="option"
        :aria-selected="index === selectedIndex ? 'true' : 'false'"
        :class="{ selected: index === selectedIndex }"
        :style="{ borderLeftColor: tag.categoryColor }"
        @mousedown.prevent="choose(tag)"
        @mouseenter="selectedIndex = index"
      >
        <span class="tag-name">
          {{ spelling(tag) }}
          <em class="tag-category">{{ tag.category }}</em>
        </span>
        <span
          v-if="tag.remote"
          class="tag-count remote"
          :title="`Not in your library. ${tag.remoteCount} posts on ${tag.source}.`"
        >
          {{ tag.source }} {{ formatCount(tag.remoteCount) }}
        </span>
        <span v-else class="tag-count">{{ tag.usageCount }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue'
import api from '../api/client'
import { booruSearchTag } from '../utils/booruSearchTag.js'

// One tag name with autocomplete from this library and, always, from the
// public boorus - for fields like "Alias of..." whose job is finding the
// booru's name for a tag. Enter with a highlighted row picks it; otherwise
// Enter is left to the surrounding form.
const props = defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  placeholder: {
    type: String,
    default: '',
  },
  // Rows to leave out, e.g. the tag being aliased itself.
  exclude: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['update:modelValue'])

const input = ref(null)
const suggestions = ref([])
const selectedIndex = ref(-1)
// Fixed to the window, so a scrolling table around the field cannot clip it.
const listStyle = ref({})
let debounceTimer = null
let requestSeq = 0

// The booru spelling, brackets and all: honoka_(doa) rather than the stored
// honoka_doa, so a new canonical tag keeps its readable name.
function spelling(tag) {
  return booruSearchTag(tag.name, tag.displayName)
}

function onInput(value) {
  emit('update:modelValue', value)
  clearTimeout(debounceTimer)
  const query = value.trim()
  if (!query) {
    clear()
    return
  }
  // Remote rows can reach a public booru, so wait for a pause in typing.
  debounceTimer = setTimeout(() => lookup(query), 300)
}

async function lookup(query) {
  const seq = ++requestSeq
  try {
    const rows = await api.autocomplete(query, { includeRemote: true, forceRemote: true })
    if (seq !== requestSeq) return
    suggestions.value = (rows || []).filter((tag) => tag.name !== props.exclude)
    selectedIndex.value = -1
    placeList()
  } catch {
    if (seq === requestSeq) clear()
  }
}

function placeList() {
  const rect = input.value?.getBoundingClientRect()
  if (!rect) return
  listStyle.value = { top: `${rect.bottom + 2}px`, left: `${rect.left}px`, minWidth: `${rect.width}px` }
  window.addEventListener('scroll', clear, true)
  window.addEventListener('resize', clear)
}

function choose(tag) {
  emit('update:modelValue', spelling(tag))
  clear()
  input.value?.focus()
}

function move(step) {
  if (!suggestions.value.length) return
  const count = suggestions.value.length
  selectedIndex.value = (selectedIndex.value + step + count) % count
}

function onEnter(event) {
  if (selectedIndex.value < 0 || !suggestions.value[selectedIndex.value]) return
  event.preventDefault()
  choose(suggestions.value[selectedIndex.value])
}

function onEscape(event) {
  if (!suggestions.value.length) return
  // Close the list first; a second Escape reaches the surrounding form.
  event.stopPropagation()
  event.preventDefault()
  clear()
}

function onBlur() {
  // Late enough for a click on a row to land first.
  setTimeout(clear, 150)
}

function clear() {
  requestSeq += 1
  suggestions.value = []
  selectedIndex.value = -1
  window.removeEventListener('scroll', clear, true)
  window.removeEventListener('resize', clear)
}

// The board's post count, abbreviated so it cannot pass for a local count.
function formatCount(count) {
  const value = Number(count) || 0
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function focus() {
  input.value?.focus()
}

defineExpose({ focus })
onBeforeUnmount(() => {
  clearTimeout(debounceTimer)
  clear()
})
</script>

<style scoped>
.tag-name-input {
  position: relative;
  display: inline-block;
}

.tag-name-input input {
  width: 100%;
}

.suggestions {
  position: fixed;
  z-index: 1000;
  width: max-content;
  max-width: 420px;
  max-height: 280px;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem 0;
  list-style: none;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

.suggestions li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.4rem 0.65rem;
  border-left: 3px solid transparent;
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}

.suggestions li.selected {
  background: var(--bg-tertiary);
}

.tag-category {
  margin-left: 0.4rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-style: normal;
}

.tag-count {
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.tag-count.remote {
  font-style: italic;
}
</style>
