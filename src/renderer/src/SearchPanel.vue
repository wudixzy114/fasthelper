<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  ArrowRight, ArrowUpRight, CornerDownLeft, FileText, FolderOpen, LoaderCircle,
  Search, Zap,
} from '@lucide/vue'
import { searchSourceLabels, type FeatureId, type SearchSource, type SearchResult, type SearchKind } from '../../shared/contracts'
import { useSettings } from './store'

const store = useSettings()
const api = window.fasthelper
const props = withDefaults(defineProps<{ pluginId: FeatureId; compact?: boolean; active?: boolean }>(), { active: true })
const input = ref<HTMLInputElement>()
const query = ref('')
const results = ref<SearchResult[]>([])
const notices = ref<string[]>([])
const sources = ref<SearchSource[]>([])
const fallbackReason = ref('')
const error = ref('')
const feedback = ref('')
const loading = ref(false)
const opening = ref(false)
const submitted = ref(false)
const selected = ref(-1)
const filter = ref<'all' | 'app' | 'file'>('all')
const groupLabels: Record<SearchKind, string> = {
  app: '应用', file: '文件', folder: '文件夹', portable: '便携程序',
  installer: '安装器', uninstaller: '卸载器', helper: '辅助程序',
}
const matchLabels = { high: '匹配度高', medium: '匹配度一般', low: '匹配度低' }
const groupedResults = computed(() => {
  const groups = new Map<SearchKind, SearchResult[]>()
  for (const item of results.value) {
    const application = item.kind === 'app' || item.kind === 'portable'
    if (filter.value === 'app' && !application || filter.value === 'file' && application) continue
    groups.set(item.kind, [...(groups.get(item.kind) ?? []), item])
  }
  let index = 0
  return [...groups].flatMap(([kind, items]) =>
    items.map((item, offset) => ({ item, index: index++, heading: offset === 0 ? groupLabels[kind] : null })))
})
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' })

function resultDetail(item: SearchResult) {
  const date = item.date ? new Date(item.date) : undefined
  return date && !Number.isNaN(date.valueOf()) ? `${item.detail} · ${dateFormat.format(date)}` : item.detail
}
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined

function focusInput() {
  if (!props.active) return
  input.value?.focus()
  input.value?.select()
}

function visibilityChanged() {
  if (document.hidden) query.value = ''
  else focusInput()
}

onMounted(() => {
  focusInput()
  if (props.compact) {
    window.addEventListener('focus', focusInput)
    document.addEventListener('visibilitychange', visibilityChanged)
  }
})
onUnmounted(() => {
  clearTimeout(timer)
  void api.closeSearch(props.pluginId).catch(() => undefined)
  window.removeEventListener('focus', focusInput)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
watch(() => props.active, (active) => { if (active) focusInput() }, { flush: 'post' })
watch(filter, () => { selected.value = -1 })

watch(query, (value) => {
  clearTimeout(timer)
  generation += 1
  results.value = []
  notices.value = []
  sources.value = []
  fallbackReason.value = ''
  error.value = ''
  feedback.value = ''
  loading.value = false
  submitted.value = false
  selected.value = -1
  if (value.trim()) timer = setTimeout(() => void search(false), 125)
  else void api.closeSearch(props.pluginId).catch(() => undefined)
}, { flush: 'sync' })

watch(() => results.value.length, (count) => {
  if (props.compact && (!loading.value || count)) void api.resizeLauncher(173 + count * 47).catch(() => undefined)
})

async function search(commit: boolean) {
  clearTimeout(timer)
  if (!query.value.trim() || (commit && opening.value)) return
  const request = ++generation
  submitted.value = commit
  loading.value = true
  error.value = ''
  selected.value = -1
  results.value = []
  notices.value = []
  sources.value = []
  fallbackReason.value = ''
  try {
    const response = await api.search(props.pluginId, query.value, commit)
    if (request !== generation) return
    sources.value = response.sources
    fallbackReason.value = response.fallbackReason ?? ''
    if (response.opened) {
      if (props.compact) {
        query.value = ''
        await api.hideLauncher()
      } else feedback.value = `已打开 ${response.opened}。`
      return
    }
    results.value = response.results
    notices.value = response.notices
  } catch {
    if (request === generation) error.value = '无法完成搜索，请重试。'
  } finally {
    if (request === generation) loading.value = false
  }
}

async function open(item: SearchResult, action: 'open' | 'reveal' | 'add' = 'open') {
  if (opening.value) return
  opening.value = true
  error.value = ''
  try {
    const response = await window.fasthelper.openResult(item.id, action)
    if (response.ok) {
      if (action === 'add') {
        feedback.value = '已添加为应用。'
        await search(false)
        return
      }
      if (props.compact) {
        query.value = ''
        await api.hideLauncher()
      } else feedback.value = action === 'reveal' ? '已在资源管理器中定位。' : `已打开 ${item.title}。`
    } else error.value = response.message
  } catch {
    error.value = '无法打开结果，请重新搜索。'
  } finally {
    opening.value = false
  }
}

async function manageSaved(item: SearchResult, action: 'relocate' | 'remove') {
  if (!item.savedId || opening.value) return
  opening.value = true
  error.value = ''
  try {
    const result = await api.manageSavedApplication(item.savedId, action)
    if (result.ok) {
      feedback.value = action === 'relocate' ? '应用位置已更新。' : '已移除应用条目。'
      await search(false)
    } else error.value = result.message
  } catch {
    error.value = '无法更新已添加的应用。'
  } finally {
    opening.value = false
  }
}

function keys(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) {
    if (event.key === 'Enter') event.preventDefault()
    return
  }
  if (event.key === 'Escape' && props.compact) {
    event.preventDefault()
    void window.fasthelper.hideLauncher()
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const count = groupedResults.value.length
    if (!count) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    if (selected.value === -1 && step < 0) selected.value = count - 1
    else selected.value = (selected.value + step + count) % count
    document.getElementById(`result-${selected.value}`)?.scrollIntoView({ block: 'nearest' })
  }
}

function submit() {
  const item = groupedResults.value[selected.value]?.item
  if (item?.missing) void manageSaved(item, 'relocate')
  else if (item) void open(item, item.canOpen ? 'open' : 'reveal')
  else if (!submitted.value || !loading.value) void search(true)
}

</script>

<template>
  <section :class="['search-panel', { 'search-panel-compact': compact }]" @keydown.esc="keys">
    <form class="searchbox" @submit.prevent="submit">
      <Search :size="23" aria-hidden="true" />
      <input ref="input" v-model="query" aria-label="搜索或输入指令" placeholder="输入应用名，或用「找」搜索文件" maxlength="250"
        autocomplete="off" @keydown.down="keys" @keydown.up="keys" @keydown.enter="keys" />
      <button class="button button-primary" type="submit" :disabled="!query.trim() || (submitted && loading)" aria-label="执行指令">
        <LoaderCircle v-if="submitted && loading" :size="17" class="spinning" /><ArrowRight v-else :size="19" />
      </button>
    </form>

    <div v-if="!compact" class="search-filters" aria-label="搜索结果分类">
      <button v-for="[id, label] in ([['all', '全部'], ['app', '应用'], ['file', '文件']] as const)"
        :key="id" class="search-filter" :aria-pressed="filter === id" @click="filter = id">{{ label }}</button>
    </div>
    <p v-if="sources.length || fallbackReason" class="search-sources" role="status">
      <strong v-if="sources.length">本次搜索 · {{ sources.map((id) => searchSourceLabels[id]).join(' + ') }}</strong>
      <span v-if="fallbackReason">{{ fallbackReason }}</span>
    </p>
    <slot name="status" />
    <div v-if="error || store.error" class="launcher-feedback error" role="alert">{{ error || store.error }}</div>
    <p v-else-if="feedback" class="launcher-feedback" role="status">{{ feedback }}</p>
    <ul v-if="groupedResults.length" class="results" aria-label="搜索结果">
      <template v-for="{ item, index, heading } in groupedResults" :key="item.id">
        <li v-if="heading" class="result-group" role="presentation">{{ heading }}</li>
        <li :id="'result-' + index" class="result" :class="{ 'result-selected': selected === index }">
          <button class="result-main" :disabled="opening || item.missing" @click="open(item, item.canOpen ? 'open' : 'reveal')">
            <span class="result-icon"><Zap v-if="item.kind === 'app'" :size="18" /><FileText v-else :size="18" /></span>
            <span class="result-text">
              <strong>{{ item.title }}</strong>
              <small :title="resultDetail(item)">{{ item.missing ? '路径已失效 · ' : '' }}{{ resultDetail(item) }}</small>
            </span>
            <span v-if="item.match" class="match-mark" :class="'match-' + item.match" :title="matchLabels[item.match]">
              <span class="sr-only">{{ matchLabels[item.match] }}</span><i></i><i></i><i></i>
            </span>
            <span v-if="!compact" class="result-source">{{ searchSourceLabels[item.source] }}</span>
            <ArrowUpRight v-if="!item.missing" :size="17" />
          </button>
          <button v-if="item.kind === 'file' && item.canOpen" class="icon-button reveal" :disabled="opening"
            aria-label="打开所在文件夹" title="打开所在文件夹" @click="open(item, 'reveal')"><FolderOpen :size="18" /></button>
          <button v-if="item.canAdd" class="result-action" :disabled="opening" @click="open(item, 'add')">添加为应用</button>
          <button v-if="item.missing" class="result-action" :disabled="opening" @click="manageSaved(item, 'relocate')">重新定位</button>
          <button v-if="item.savedId" class="result-action" :disabled="opening" @click="manageSaved(item, 'remove')">移除</button>
        </li>
      </template>
    </ul>
    <div v-else-if="loading" class="launcher-feedback" role="status"><LoaderCircle :size="17" class="spinning" /> 正在搜索…</div>
    <div v-else-if="notices.length" class="launcher-feedback" role="status">{{ notices.join(' ') }}</div>
    <div v-else-if="results.length" class="launcher-feedback" role="status">当前分类没有结果。</div>
    <div v-else-if="submitted" class="launcher-feedback" role="status">没有匹配结果。试试完整应用名，或者用「找」开头来搜索文件。</div>
    <footer v-if="compact" class="launcher-footer"><span class="launcher-keys"><kbd><CornerDownLeft :size="12" /></kbd> 执行 <kbd>Esc</kbd> 关闭</span></footer>
  </section>
</template>
