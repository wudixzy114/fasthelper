<script setup lang="ts">
import { ref, watch } from 'vue'
import type { FeatureId, PluginCollection, SavedApplicationItem } from '../../shared/contracts'

const props = defineProps<{ pluginId: FeatureId; collection: PluginCollection; active: boolean }>()
const api = window.fasthelper
const rows = ref<SavedApplicationItem[]>([])
const busy = ref(false)
const error = ref('')
let generation = 0

async function refresh() {
  const request = ++generation
  try {
    const next = await api.listPluginCollection(props.pluginId, props.collection.id)
    if (request === generation) rows.value = next
  } catch {
    if (request === generation) error.value = '无法读取已添加的应用。'
  }
}

watch(() => props.active, (active) => {
  if (active) void refresh()
}, { immediate: true })

async function act(id: string, action: 'relocate' | 'remove') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await api.manageSavedApplication(id, action)
    if (result.ok) await refresh()
    else error.value = result.message
  } catch {
    error.value = '无法更新应用条目。'
  } finally { busy.value = false }
}
</script>

<template>
  <section class="plugin-service" :aria-label="collection.title">
    <header class="plugin-service-header"><h2>{{ collection.title }}</h2></header>
    <p v-if="error" class="service-error" role="status">{{ error }}</p>
    <p v-else-if="!rows.length">从搜索结果添加的便携程序会显示在这里。</p>
    <ul v-else class="saved-application-list">
      <li v-for="item in rows" :key="item.id">
        <div class="feature-text">
          <strong>{{ item.name }}</strong>
          <p :title="item.path">{{ item.missing ? '路径已失效 · ' : '' }}{{ item.path }}</p>
        </div>
        <button class="button button-light" :disabled="busy" @click="act(item.id, 'relocate')">重新定位</button>
        <button class="button button-light" :disabled="busy" @click="act(item.id, 'remove')">移除</button>
      </li>
    </ul>
  </section>
</template>
