<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { ArrowRight, Settings2, X } from '@lucide/vue'
import Brand from './Brand.vue'
import SearchPanel from './SearchPanel.vue'
import { useSettings } from './store'

const store = useSettings()
const api = window.fasthelper
const plugin = computed(() => store.snapshot?.plugins.find((entry) =>
  entry.compactPage && store.snapshot?.features[entry.id] === 'enabled'))
let disconnect: (() => void) | undefined
onMounted(() => { disconnect = store.connect() })
onUnmounted(() => disconnect?.())
</script>

<template>
  <main class="launcher">
    <header class="launcher-header">
      <Brand :subtitle="plugin?.name" />
      <div class="launcher-window-buttons">
        <button class="icon-button" title="设置" aria-label="设置" @click="api.openSettings()"><Settings2 :size="18" /></button>
        <button class="icon-button" title="关闭" aria-label="关闭" @click="api.hideLauncher()"><X :size="19" /></button>
      </div>
    </header>
    <SearchPanel v-if="plugin" :key="plugin.id" :plugin-id="plugin.id" compact />
    <div v-else-if="store.snapshot" class="launcher-empty">
      <p>启用提供快捷搜索的插件后，可以在这里搜索。</p>
      <button class="button button-light" @click="api.openSettings()">管理功能 <ArrowRight :size="16" /></button>
    </div>
  </main>
</template>
