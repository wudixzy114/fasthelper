<script setup lang="ts">
import { ref, watch } from 'vue'
import type { FeatureId, PluginCollection, SavedApplicationItem } from '../../shared/contracts'

const props = defineProps<{ pluginId: FeatureId; collection: PluginCollection; active: boolean }>()
const api = window.fasthelper
const rows = ref<SavedApplicationItem[]>([])
const busy = ref(false)
const error = ref('')
const editing = ref('')
const aliases = ref('')
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

function edit(item: SavedApplicationItem) {
  editing.value = item.id
  aliases.value = item.aliases?.join('\n') ?? ''
}

async function save() {
  if (busy.value || !editing.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await api.setSavedApplicationAliases(editing.value, aliases.value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))
    if (result.ok) {
      editing.value = ''
      await refresh()
    } else error.value = result.message
  } catch {
    error.value = '最多可填写 10 个别名，每个别名不超过 80 个字符。'
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
        <div class="saved-application-row">
          <div class="feature-text">
            <strong>{{ item.name }}</strong>
            <p :title="item.path">{{ item.missing ? '路径已失效 · ' : '' }}{{ item.path }}</p>
            <p v-if="item.aliases?.length" :title="item.aliases.join('、')">别名 · {{ item.aliases.join('、') }}</p>
          </div>
          <button class="button button-light" :disabled="busy" @click="edit(item)">编辑别名</button>
          <button class="button button-light" :disabled="busy" @click="act(item.id, 'relocate')">重新定位</button>
          <button class="button button-light" :disabled="busy" @click="act(item.id, 'remove')">移除</button>
        </div>
        <form v-if="editing === item.id" class="saved-alias-editor" @submit.prevent="save">
          <label :for="'aliases-' + item.id">应用别名（每行一个）</label>
          <textarea :id="'aliases-' + item.id" v-model="aliases" rows="3" maxlength="810" :disabled="busy" />
          <div class="service-actions">
            <button type="submit" class="button button-primary" :disabled="busy">保存别名</button>
            <button type="button" class="button button-light" :disabled="busy" @click="editing = ''">取消</button>
          </div>
        </form>
      </li>
    </ul>
  </section>
</template>
