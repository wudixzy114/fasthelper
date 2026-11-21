<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowUpRight, ChevronRight, Cpu, FolderSearch, Grid2X2, Keyboard, LayoutDashboard } from '@lucide/vue'
import Brand from './Brand.vue'
import { useSettings } from './store'

const store = useSettings()
const route = useRoute()
const api = window.fasthelper
const navigation = [
  { route: 'overview', label: '概览', icon: LayoutDashboard },
  { route: 'features', label: '功能管理', icon: Grid2X2 },
  { route: 'model', label: '本地模型', icon: Cpu },
] as const
let disconnect: (() => void) | undefined
onMounted(() => { disconnect = store.connect() })
onUnmounted(() => disconnect?.())
</script>

<template>
  <div class="settings-shell">
    <aside class="sidebar">
      <Brand subtitle="Windows 快捷助手" />
      <nav aria-label="主导航" class="navigation">
        <RouterLink v-for="item in navigation" :key="item.route" :to="{ name: item.route }"
          class="nav-item" active-class="nav-current">
          <component :is="item.icon" :size="17" aria-hidden="true" />
          <span>{{ item.label }}</span><ChevronRight class="nav-caret" :size="15" aria-hidden="true" />
        </RouterLink>
        <template v-if="store.snapshot?.plugins.length">
          <p class="nav-heading">插件</p>
          <RouterLink v-for="plugin in store.snapshot.plugins" :key="plugin.id"
            :to="{ name: 'plugin', params: { pluginId: plugin.id } }"
            class="nav-item" :class="{ 'nav-current': route.params.pluginId === plugin.id }">
            <FolderSearch v-if="plugin.icon === 'folder-search'" :size="17" aria-hidden="true" />
            <span>{{ plugin.name }}</span><ChevronRight class="nav-caret" :size="15" aria-hidden="true" />
          </RouterLink>
        </template>
      </nav>
      <div class="sidebar-end">
        <button class="sidebar-launch" @click="api.showLauncher()"><Keyboard :size="17" /> 快捷面板 <ArrowUpRight :size="15" /></button>
        <div v-if="store.snapshot?.shortcut" class="shortcut" aria-label="全局快捷键">
          <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>Space</kbd>
        </div>
        <small v-else-if="store.snapshot">快捷键不可用，可从托盘打开。</small>
      </div>
    </aside>
    <RouterView />
  </div>
</template>
