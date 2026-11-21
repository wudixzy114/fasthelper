<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Settings2, X } from '@lucide/vue'
import Conversation from './Conversation.vue'
import { useSettings } from './store'

const store = useSettings()
const api = window.fasthelper
const expanded = ref(false)
let disconnect: (() => void) | undefined
let unsubscribe: (() => void) | undefined
onMounted(() => {
  disconnect = store.connect()
  let changed = false
  unsubscribe = api.onLauncherState((open) => { changed = true; expanded.value = open })
  void api.launcherState().then((open) => { if (!changed) expanded.value = open }).catch(() => undefined)
})
onUnmounted(() => { disconnect?.(); unsubscribe?.() })
</script>

<template>
  <div v-show="!expanded" class="dock-handle" title="fasthelper" aria-label="fasthelper 贴边入口" />
  <main v-show="expanded" class="dock-surface">
    <header class="dock-header">
      <span>fasthelper</span>
      <div>
        <button class="icon-button" title="设置" aria-label="设置" @click="api.openSettings()"><Settings2 :size="17" /></button>
        <button class="icon-button" title="收起" aria-label="收起" @click="api.hideLauncher()"><X :size="18" /></button>
      </div>
    </header>
    <Conversation compact :active="expanded" @dismiss="api.hideLauncher()" />
  </main>
</template>
