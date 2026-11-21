<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowUp, AudioLines, FileText, FolderOpen, LoaderCircle, Mic, Square } from '@lucide/vue'
import { maxCommandLength, type ConversationResponse } from '../../shared/conversation'
import { searchKindLabels, searchSourceLabels, type SearchResult } from '../../shared/contracts'
import { useSettings } from './store'
import { useSpeech } from './useSpeech'

const props = withDefaults(defineProps<{ compact?: boolean; active?: boolean }>(), { active: true })
const emit = defineEmits<{ dismiss: [] }>()
const store = useSettings()
const api = window.fasthelper
const panel = ref<HTMLElement>()
const input = ref<HTMLTextAreaElement>()
const text = ref('')
const response = ref<ConversationResponse>({ kind: 'empty' })
const busy = ref(false)
const performing = ref(false)
const feedback = ref('')
const picked = ref(-1)
const composing = ref(false)
const voiceEnabled = computed(() => !!store.snapshot?.speech.active)
let revision = 0
let previewTimer: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined
let voiceBase = ''

const speech = useSpeech((transcript) => {
  text.value = [voiceBase, transcript].filter(Boolean).join(' ').slice(0, maxCommandLength)
}, (message) => { feedback.value = message }, () => { void submit() })
const recording = speech.state
const searching = computed(() => response.value.kind === 'search' ? response.value : undefined)
const choices = computed(() => response.value.kind === 'choices' ? response.value.choices : [])
const eligibleResults = computed(() => searching.value && !searching.value.preview && !searching.value.response.opened
  ? searching.value.response.results : [])
const actionable = computed(() => choices.value.length || eligibleResults.value.length)
const showResults = computed(() => !!searching.value && (!searching.value.preview || searching.value.response.results.length > 0))
const hold = computed(() => busy.value || performing.value || recording.value !== 'idle' || choices.value.length > 0)

function focus() {
  if (props.active && document.hasFocus() && !panel.value?.contains(document.activeElement)) input.value?.focus()
}

onMounted(() => {
  focus()
  if (props.compact && panel.value) {
    observer = new ResizeObserver(([entry]) => {
      if (props.active && entry.contentRect.height) void api.resizeLauncher(Math.ceil(entry.contentRect.height + 32)).catch(() => undefined)
    })
    observer.observe(panel.value)
    window.addEventListener('focus', focus)
  }
})
onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('focus', focus)
  clearTimeout(previewTimer)
  void api.cancelConversation().catch(() => undefined)
})
watch(hold, (held) => { if (props.compact) void api.holdLauncher(held).catch(() => undefined) })
watch(() => props.active, (active) => {
  if (active) { void nextTick(focus); schedulePreview() }
  else { speech.cancel(); reset() }
})
watch(voiceEnabled, (enabled) => { if (!enabled) speech.cancel() })

function reset() {
  clearTimeout(previewTimer)
  revision += 1
  busy.value = false
  performing.value = false
  response.value = { kind: 'empty' }
  picked.value = -1
  feedback.value = ''
  void api.cancelConversation().catch(() => undefined)
}

function schedulePreview() {
  clearTimeout(previewTimer)
  if (!props.active || composing.value || !text.value.trim()) return
  const visibleRevision = revision
  previewTimer = setTimeout(async () => {
    try {
      const result = await api.converse(text.value, 'preview')
      if (visibleRevision === revision) response.value = result
    } catch { /* Submission can report errors for this input. */ }
  }, recording.value === 'idle' ? 230 : 360)
}

watch(text, () => { reset(); schedulePreview() }, { flush: 'sync' })

async function send(request: () => Promise<ConversationResponse>) {
  if (busy.value || performing.value) return
  clearTimeout(previewTimer)
  const current = ++revision
  busy.value = true
  picked.value = -1
  response.value = { kind: 'empty' }
  feedback.value = ''
  try {
    const result = await request()
    if (current === revision) response.value = result
  } catch {
    if (current === revision) feedback.value = '未能完成这条指令，请重试。'
  } finally {
    if (current === revision) busy.value = false
  }
}

async function submit() {
  if (composing.value || !props.active || busy.value || performing.value) return
  if (recording.value === 'recording' || recording.value === 'finishing') { await speech.finish(true); return }
  if (recording.value === 'starting' || !text.value.trim()) return
  if (choices.value.length) {
    const choice = choices.value[picked.value]
    if (choice) await send(() => api.choosePlugin(choice.token))
    return
  }
  const item = eligibleResults.value[picked.value]
  if (item) await open(item)
  else await send(() => api.converse(text.value, 'submit'))
}

async function open(item: SearchResult, action: 'open' | 'reveal' | 'add' = item.canOpen ? 'open' : 'reveal') {
  if (performing.value || item.missing || searching.value?.preview) return
  performing.value = true
  const current = revision
  try {
    const result = await api.openConversationResult(item.id, action)
    if (current !== revision) return
    feedback.value = result.ok ? (action === 'open' ? '已打开 ' + item.title : action === 'reveal' ? '已定位 ' + item.title : '已添加为应用。')
      : result.message
  } catch { if (current === revision) feedback.value = '无法完成结果操作。' }
  finally { if (current === revision) performing.value = false }
}

function keys(event: KeyboardEvent) {
  if (composing.value || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!event.repeat) void submit() }
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && actionable.value) {
    event.preventDefault()
    const count = actionable.value
    const step = event.key === 'ArrowDown' ? 1 : -1
    picked.value = (picked.value === -1 && step < 0) ? count - 1 : (picked.value + step + count) % count
    panel.value?.querySelector('[data-picked=true]')?.scrollIntoView({ block: 'nearest' })
  }
}

function toggleVoice() {
  if (recording.value === 'idle') {
    voiceBase = text.value.trim()
    feedback.value = ''
    void speech.begin()
  } else if (recording.value === 'starting') speech.cancel()
  else void speech.finish()
}

function escape(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || composing.value) return
  if (recording.value !== 'idle') speech.cancel()
  else if (props.compact) emit('dismiss')
  else reset()
}
</script>

<template>
  <section ref="panel" :class="['conversation', { 'conversation-compact': compact }]" @keydown.esc="escape">
    <h1 v-if="!compact">想做什么？</h1>
    <form class="command-composer" @submit.prevent="submit">
      <textarea ref="input" v-model="text" :maxlength="maxCommandLength" rows="2" aria-label="输入指令"
        placeholder="例如，帮我找到上周的项目周报" @keydown="keys" @input="speech.cancel"
        @compositionstart="composing = true" @compositionend="composing = false; schedulePreview()" />
      <div class="command-controls">
        <button v-if="voiceEnabled" type="button" :class="['icon-button', { 'mic-on': recording !== 'idle' }]"
          :aria-label="recording === 'idle' ? '开始语音输入' : '结束语音输入'" :aria-pressed="recording !== 'idle'"
          @click="toggleVoice">
          <Mic v-if="recording === 'idle'" :size="18" /><Square v-else :size="15" />
        </button>
        <RouterLink v-else-if="!compact" :to="{ name: 'speech' }" class="icon-button" aria-label="设置本地语音"><Mic :size="18" /></RouterLink>
        <span v-if="recording !== 'idle'" class="voice-state" role="status"><AudioLines :size="16" />
          {{ recording === 'starting' ? '正在打开麦克风' : recording === 'finishing' ? '正在完成转写' : '正在聆听' }}
        </span>
        <button class="button button-primary send-command" type="submit" aria-label="提交指令"
          :disabled="(!text.trim() && recording !== 'recording') || busy">
          <LoaderCircle v-if="busy" class="spinning" :size="17" /><ArrowUp v-else :size="18" />
        </button>
      </div>
    </form>

    <p v-if="busy" class="command-status" role="status">正在处理指令…</p>
    <p v-if="feedback" class="command-status" role="status">{{ feedback }}</p>
    <p v-if="response.kind === 'notice' || response.kind === 'choices'" class="command-status" role="status">{{ response.message }}</p>
    <ul v-if="choices.length" class="command-options" aria-label="插件候选">
      <li v-for="(choice, index) in choices" :key="choice.token" :data-picked="picked === index">
        <button type="button" @click="send(() => api.choosePlugin(choice.token))"><strong>{{ choice.title }}</strong><small>{{ choice.description }}</small></button>
      </li>
    </ul>
    <section v-if="showResults && searching" class="command-output" aria-label="插件结果">
      <header>{{ searching.title }} <span v-if="searching.preview">· 预览</span></header>
      <p v-if="searching.response.opened" class="command-status" role="status">已打开 {{ searching.response.opened }}</p>
      <p v-if="searching.response.sources.length" class="command-sources">
        {{ searching.response.sources.map((source) => searchSourceLabels[source]).join(' + ') }}
      </p>
      <p v-if="!searching.preview && searching.response.fallbackReason" class="command-sources">{{ searching.response.fallbackReason }}</p>
      <p v-if="!searching.preview && searching.response.notices.length" class="command-status">{{ searching.response.notices.join(' ') }}</p>
      <ul class="command-options" aria-label="搜索结果">
        <li v-for="(item, index) in searching.response.results" :key="item.id" :data-picked="picked === index">
          <div v-if="searching.preview || item.missing" class="command-option"><strong>{{ item.title }}</strong>
            <small>{{ item.missing ? '路径已失效 · ' : '' }}{{ searchKindLabels[item.kind] }} · {{ item.detail }}</small>
          </div>
          <button v-else type="button" :disabled="performing" @click="open(item)"><strong>{{ item.title }}</strong>
            <small>{{ searchKindLabels[item.kind] }} · {{ item.detail }}</small>
          </button>
          <button v-if="!searching.preview && item.canAdd" type="button" class="icon-button" aria-label="添加为应用" @click="open(item, 'add')"><FileText :size="16" /></button>
          <button v-if="!searching.preview && item.canOpen && item.kind === 'file'" type="button" class="icon-button" aria-label="打开所在文件夹"
            @click="open(item, 'reveal')"><FolderOpen :size="16" /></button>
        </li>
      </ul>
    </section>
  </section>
</template>
