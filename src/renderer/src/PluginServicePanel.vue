<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Switch } from '@headlessui/vue'
import type { FeatureId, PluginService, PluginServiceAction, PluginServiceState } from '../../shared/contracts'

const props = defineProps<{ pluginId: FeatureId; service: PluginService; state?: PluginServiceState; summary?: boolean }>()
const api = window.fasthelper
const now = ref(Date.now())
const busy = ref(false)
const error = ref('')
const labels: Record<PluginServiceState['status'], string> = {
  off: '已关闭', waiting: '等待检测', connecting: '正在连接下载源',
  downloading: '正在下载', verifying: '正在校验和安装', starting: '正在连接客户端',
  indexing: '索引加载中', ready: '可用', unavailable: '暂不可用',
}
const status = computed(() => props.state?.status ?? 'waiting')
const inProgress = computed(() =>
  ['connecting', 'downloading', 'verifying', 'starting', 'indexing'].includes(status.value))
const elapsed = computed(() => {
  if (!inProgress.value || !props.state?.since) return ''
  const seconds = Math.floor(Math.max(0, now.value - props.state.since) / 1000)
  return seconds < 60 ? `已等待 ${seconds} 秒` : `已等待 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
})
const installed = computed(() =>
  props.state?.installed === undefined ? '正在检测安装状态' : props.state.installed ? '已安装' : '尚未安装')
const lastCheck = computed(() => props.state?.checkedAt
  ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(props.state.checkedAt)) : '')
const supports = (action: PluginServiceAction) => props.service.actions.includes(action)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { if (inProgress.value) now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(timer))

function size(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${Math.round(bytes / 1000)} KB`
}

async function act(action: PluginServiceAction) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api.managePluginService(props.pluginId, props.service.id, action)
  } catch {
    error.value = '操作未完成，请稍后重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section :class="['plugin-service', { 'plugin-service-summary': summary }]" :aria-label="service.title">
    <header class="plugin-service-header">
      <div>
        <h2>{{ service.title }}</h2>
        <p><strong :class="{ 'service-ready': status === 'ready' }">{{ labels[status] }}</strong>
          <span> · {{ installed }}</span><span v-if="state?.version"> · {{ state.version }}</span>
        </p>
      </div>
      <Switch v-if="!summary && supports('enable') && supports('disable')" :model-value="state?.enabled ?? false"
        :disabled="busy" :aria-label="'启用 ' + service.title" class="toggle"
        @update:model-value="act($event ? 'enable' : 'disable')"><span /></Switch>
    </header>

    <div v-if="state?.progress" class="service-progress">
      <p>{{ state.progress.component }} · {{ size(state.progress.transferred) }} / {{ size(state.progress.total) }}</p>
      <progress :max="state.progress.total" :value="state.progress.transferred" :aria-label="service.title + ' 下载进度'" />
    </div>
    <p v-if="elapsed" class="service-meta">{{ elapsed }}</p>
    <p v-if="!summary && lastCheck" class="service-meta">最近检测 {{ lastCheck }}</p>
    <p v-if="state?.error || error" class="service-error" role="status">{{ error || state?.error }}</p>

    <div v-if="!summary" class="service-actions">
      <button v-if="state?.enabled && supports('check') && !['connecting', 'downloading', 'verifying'].includes(status)"
        class="button button-light" :disabled="busy" @click="act('check')">重新检测</button>
      <button v-if="supports('cancel') && ['connecting', 'downloading'].includes(status)"
        class="button button-light" :disabled="busy" @click="act('cancel')">取消下载</button>
      <button v-if="state?.canOpen && state?.enabled && supports('open')" class="button button-light" :disabled="busy"
        @click="act('open')">打开 {{ service.title.split(' ')[0] }}</button>
      <button v-if="state?.installed && state?.managed && supports('remove')" class="button button-light" :disabled="busy || inProgress"
        @click="act('remove')">卸载 {{ service.title.split(' ')[0] }}</button>
    </div>
  </section>
</template>
