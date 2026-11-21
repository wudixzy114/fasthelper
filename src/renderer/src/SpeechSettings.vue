<script setup lang="ts">
import { computed, ref } from 'vue'
import { Mic } from '@lucide/vue'
import { speechOptions, type SpeechModelId } from '../../shared/speech'
import type { ModelAction } from '../../shared/contracts'
import { useSettings } from './store'

const store = useSettings()
const api = window.fasthelper
const settings = computed(() => store.snapshot?.speech)
const pending = ref(false)
const error = ref('')
const processing = computed(() => Object.values(settings.value?.models ?? {}).some(({ status }) =>
  status === 'downloading' || status === 'verifying' || status === 'removing'))
const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1) + ' MB'
const progress = (id: SpeechModelId) => {
  const model = settings.value?.models[id]
  return model?.status === 'downloading' ? model : null
}
const modelError = (id: SpeechModelId) => {
  const model = settings.value?.models[id]
  return model?.status === 'error' ? model.message : ''
}

async function act(id: SpeechModelId, action: ModelAction | 'disable') {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    if (action === 'disable') await api.disableSpeechModel()
    else await api.manageSpeechModel(id, action)
  } catch { error.value = '未能更改语音模型，请稍后重试。' }
  finally { pending.value = false }
}
</script>

<template>
  <main class="settings-main speech-settings">
    <header class="page-header">
      <h1>本地语音</h1>
      <p>按需下载中文语音识别。安装后可以在首页和悬浮窗使用麦克风。</p>
    </header>
    <p v-if="error" class="model-error" role="alert">{{ error }}</p>
    <template v-if="settings">
      <section v-for="option in speechOptions" :key="option.id" class="plugin-service speech-model">
        <header class="plugin-service-header">
          <div>
            <h2><Mic :size="17" /> {{ option.name }} · {{ option.size }}</h2>
            <p>{{ option.description }} · {{ mb(option.bytes) }}</p>
          </div>
          <small v-if="settings.active === option.id">使用中</small>
        </header>
        <template v-if="progress(option.id)">
          <progress :value="progress(option.id)!.receivedBytes" :max="progress(option.id)!.totalBytes" aria-label="语音模型下载进度" />
          <p>{{ mb(progress(option.id)!.receivedBytes) }} / {{ mb(progress(option.id)!.totalBytes) }}</p>
          <button class="button button-light" :disabled="pending" @click="act(option.id, 'cancel')">取消下载</button>
        </template>
        <p v-else-if="settings.models[option.id]?.status === 'verifying'" role="status">正在校验并安装…</p>
        <p v-else-if="settings.models[option.id]?.status === 'removing'" role="status">正在卸载…</p>
        <div v-else class="service-actions">
          <template v-if="settings.models[option.id]?.status === 'installed'">
            <button v-if="settings.active === option.id" class="button button-light" :disabled="pending" @click="act(option.id, 'disable')">停用</button>
            <button v-else class="button button-primary" :disabled="pending || processing" @click="act(option.id, 'activate')">设为当前模型</button>
            <button class="button button-light" :disabled="pending || processing" @click="act(option.id, 'remove')">卸载模型</button>
          </template>
          <button v-else class="button button-primary" :disabled="pending || processing" @click="act(option.id, 'install')">下载并安装语音模型</button>
        </div>
        <p v-if="modelError(option.id)" class="model-error" role="alert">{{ modelError(option.id) }}</p>
      </section>
    </template>
  </main>
</template>
