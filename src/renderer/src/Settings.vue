<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Dialog, DialogPanel, DialogTitle, Switch, Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/vue'
import {
  ArrowDownToLine, ArrowUpRight, Check, Cpu, FolderSearch,
  LoaderCircle, ShieldCheck, Trash2,
} from '@lucide/vue'
import { features, modelOptions, type FeatureId, type ModelId } from '../../shared/contracts'
import { useSettings } from './store'

const store = useSettings()
const api = window.fasthelper
const route = useRoute()
const routeInfo = {
  overview: { title: '设置', description: '管理桌面入口和应用更新。' },
  features: { title: '功能管理', description: '按需安装、停用或移除独立插件。' },
  model: { title: '本地模型', description: '选择 SemIf 和语言理解共用的千问权重。' },
} as const
const currentPage = computed(() => route.name === 'features' || route.name === 'model' ? route.name : 'overview')
const info = computed(() => routeInfo[currentPage.value])
const updateLabels = {
  unconfigured: '正式更新源尚未配置',
  idle: '自动检查更新已开启',
  checking: '正在检查更新…',
  downloading: '正在下载更新',
  ready: '新版已下载',
  current: '当前已是最新版本',
  error: '更新失败，请重试',
}
const snapshot = computed(() => store.snapshot)
const modelTab = ref(0)
const selection = computed(() => modelOptions[modelTab.value])
const model = computed(() => snapshot.value?.models[selection.value.id])
const isActive = computed(() => snapshot.value?.activeModel === selection.value.id)
const operationInProgress = computed(() => Object.values(snapshot.value?.models ?? {}).some(
  ({ status }) => status === 'downloading' || status === 'verifying' || status === 'removing',
))
const installed = computed(() => model.value?.status === 'installed' || model.value?.status === 'removing')
const percent = computed(() => model.value?.status === 'downloading'
  ? Math.min(99, Math.floor(model.value.receivedBytes / model.value.totalBytes * 100))
  : 100)
const size = computed(() => selection.value.weightsBytes >= 1_000_000_000
  ? `${(selection.value.weightsBytes / 1_000_000_000).toFixed(2)} GB`
  : `${Math.round(selection.value.weightsBytes / 1_000_000)} MB`)
const testing = ref<ModelId | null>(null)
const testStatus = ref<{ id: ModelId; text: string; ok: boolean }>()
const removal = ref<{ model: ModelId; name: string } | { feature: FeatureId; name: string } | null>(null)
const activeCount = computed(() => Object.values(snapshot.value?.features ?? {}).filter((state) => state === 'enabled').length)
watch(snapshot, (next, previous) => {
  if (!previous && next?.activeModel) modelTab.value = modelOptions.findIndex((option) => option.id === next.activeModel)
}, { immediate: true })

function launch() { void window.fasthelper.showLauncher() }
function source() { void window.fasthelper.openModelSource(selection.value.id).catch(() => {
  store.error = '无法打开模型来源。请检查默认浏览器设置。'
}) }

async function testModel() {
  if (testing.value || !isActive.value) return
  const id = selection.value.id
  testing.value = id
  testStatus.value = undefined
  try {
    const result = await window.fasthelper.testModel()
    testStatus.value = result.ok
      ? { id, text: '测试通过，本地模型已返回完整的候选评分。', ok: true }
      : { id, text: result.message, ok: false }
  } catch {
    testStatus.value = { id, text: '测试未完成，请重试。', ok: false }
  } finally {
    testing.value = null
  }
}

function confirmRemoval() {
  const target = removal.value
  removal.value = null
  if (!target) return
  if ('model' in target) {
    testStatus.value = undefined
    void store.manageModel(target.model, 'remove')
  } else void store.setFeature(target.feature, 'available')
}
</script>

<template>
  <main class="settings-main">
    <header class="page-header">
      <div><h1>{{ info.title }}</h1><p>{{ info.description }}</p></div>
      <button class="button button-light page-launch" @click="launch">打开快捷面板 <ArrowUpRight :size="16" /></button>
    </header>
    <p v-if="store.error" class="feedback error" role="alert">{{ store.error }}</p>
    <p v-else-if="!snapshot" class="feedback" role="status">正在读取设置…</p>
    <p v-else-if="snapshot.legacyCleanupPending" class="feedback" role="status">旧版模型文件暂未清理。fasthelper 会在下次启动时重试。</p>
    <p v-else-if="snapshot.retiredLegacyPackage && !snapshot.activeModel" class="feedback" role="status">已移除旧版千问模型。请选择一档千问 3.5 权重。</p>

    <template v-if="snapshot">
      <section v-if="currentPage === 'model'" aria-labelledby="model-title" class="model-card">
        <div class="model-body">
          <div class="model-eyebrow"><Cpu :size="16" /> 可选 · 本地语义决策</div>
          <h2 id="model-title">SemIf + Qwen3.5</h2>
          <TabGroup :selected-index="modelTab" @change="modelTab = $event">
            <TabList class="model-tabs" aria-label="选择 Qwen3.5 权重">
              <Tab v-for="option in modelOptions" :key="option.id" class="model-tab">
                {{ option.size }}
                <span v-if="snapshot.activeModel === option.id">使用中</span>
                <span v-else-if="snapshot.models[option.id].status === 'installed'">已安装</span>
                <span v-else-if="snapshot.models[option.id].status === 'downloading' || snapshot.models[option.id].status === 'verifying'">安装中</span>
              </Tab>
            </TabList>
            <TabPanels>
              <TabPanel v-for="option in modelOptions" :key="option.id" class="model-tab-panel">
                <template v-if="option.id === selection.id">
                  <p>{{ selection.description }}</p>
                  <div class="model-meta">
                    <span>{{ selection.quantization }}</span><span>{{ size }} 权重</span><span>Apache 2.0</span>
                  </div>
                  <div v-if="model?.status === 'downloading' || model?.status === 'verifying'" class="model-progress">
                    <div class="progress-label">
                      <span>{{ model.status === 'verifying' ? '正在完成校验与安装' : '正在下载' }}</span>
                      <span>{{ percent }}%</span>
                    </div>
                    <progress :value="percent" max="100" aria-label="模型安装进度" />
                    <button class="text-button" :disabled="store.busyModel"
                      @click="store.manageModel(selection.id, 'cancel')">取消安装</button>
                  </div>
                  <div v-else-if="installed" class="model-actions">
                    <span class="pill ready">
                      <Check :size="14" /> {{ model?.status === 'removing' ? '正在移除' : isActive ? '当前模型' : '已安装' }}
                    </span>
                    <button v-if="isActive" class="button button-light" :disabled="!!testing || store.busyModel" @click="testModel">
                      <LoaderCircle v-if="testing === selection.id" :size="16" class="spinning" />
                      {{ testing === selection.id ? '测试中…' : '测试模型' }}
                    </button>
                    <button v-else class="button button-light" :disabled="!!testing || store.busyModel || model?.status === 'removing'"
                      @click="store.manageModel(selection.id, 'activate')">设为当前模型</button>
                    <button class="icon-button dark-icon" aria-label="移除本地模型" title="移除本地模型"
                      :disabled="!!testing || store.busyModel || operationInProgress"
                      @click="removal = { model: selection.id, name: selection.name }"><Trash2 :size="17" /></button>
                  </div>
                  <div v-else class="model-actions">
                    <button class="button button-primary" :disabled="store.busyModel || operationInProgress"
                      @click="store.manageModel(selection.id, 'install')">
                      <ArrowDownToLine :size="17" />{{ model?.status === 'error' ? '重新下载并安装' : '下载并安装' }}
                    </button>
                    <button class="text-button model-source" @click="source">模型来源 <ArrowUpRight :size="15" /></button>
                  </div>
                  <p v-if="model?.status === 'error'" class="model-error" role="alert">{{ model.message }}</p>
                  <p v-if="testStatus?.id === selection.id" :class="testStatus.ok ? 'model-success' : 'model-error'" role="status">
                    {{ testStatus.text }}
                  </p>
                </template>
              </TabPanel>
            </TabPanels>
          </TabGroup>
        </div>
        <div class="model-art" aria-hidden="true">
          <div class="model-orbit orbit-one"></div><div class="model-orbit orbit-two"></div>
          <div class="model-core"><Cpu :size="51" :stroke-width="1.22" /></div>
          <i class="orbit-dot one"></i><i class="orbit-dot two"></i>
        </div>
      </section>

      <section v-if="currentPage === 'features'" aria-labelledby="features-title" class="features">
        <header class="section-header">
          <div><h2 id="features-title">已提供的插件</h2><p>{{ activeCount }} 项已启用</p></div>
        </header>
        <div class="feature-list">
          <article v-for="feature in features" :key="feature.id" class="feature">
            <div class="feature-icon files"><FolderSearch :size="23" :stroke-width="1.8" aria-hidden="true" /></div>
            <div class="feature-text">
              <h3>{{ feature.name }}</h3><p>{{ feature.description }}</p>
              <small v-if="snapshot.pluginUpdateRequired">已有的插件包需要更新后才能打开工作区。</small>
            </div>
            <button v-if="snapshot.features[feature.id] === 'available'" class="button button-light feature-install"
              :disabled="!!store.busyFeature" @click="store.setFeature(feature.id, 'enabled')">
              <span class="sr-only">{{ feature.name }}</span>{{ snapshot.pluginInstalling ? '安装中…' : snapshot.pluginUpdateRequired ? '更新插件' : snapshot.pluginOnline ? '安装' : '导入插件' }}
            </button>
            <div v-else class="feature-controls">
                <RouterLink :to="{ name: 'plugin', params: { pluginId: feature.id } }" class="button button-light">打开</RouterLink>
              <Switch :model-value="snapshot.features[feature.id] === 'enabled'" :disabled="!!store.busyFeature"
                :aria-label="'启用' + feature.name" class="toggle"
                @update:model-value="store.setFeature(feature.id, $event ? 'enabled' : 'disabled')"><span /></Switch>
              <button v-if="currentPage === 'features'" class="icon-button" :aria-label="'移除' + feature.name" :title="'移除' + feature.name"
                @click="removal = { feature: feature.id, name: feature.name }"><Trash2 :size="17" /></button>
            </div>
          </article>
        </div>
      </section>

      <article v-if="currentPage === 'overview'" class="feature dependency">
        <div class="feature-text">
          <h3>应用更新 · {{ snapshot.update.version }}</h3>
          <p>{{ snapshot.update.message || updateLabels[snapshot.update.status] }}
            <span v-if="snapshot.update.percent !== undefined">{{ snapshot.update.percent }}%</span></p>
        </div>
        <button v-if="snapshot.update.status === 'ready'" class="button button-primary" @click="api.manageUpdate('install')">重启并更新</button>
        <button v-else-if="snapshot.update.status !== 'unconfigured'" class="button button-light"
          :disabled="['checking', 'downloading'].includes(snapshot.update.status)"
          @click="api.manageUpdate('check')">检查更新</button>
      </article>
      <footer class="local-note"><ShieldCheck :size="17" /> 应用目录、文件查询和模型输入均在设备上处理。</footer>
    </template>

    <Dialog :open="removal !== null" class="dialog" @close="removal = null">
      <div class="dialog-backdrop" aria-hidden="true"></div>
      <div class="dialog-layout">
        <DialogPanel class="dialog-panel">
          <DialogTitle class="dialog-title">移除{{ removal?.name }}？</DialogTitle>
          <p v-if="removal && 'model' in removal">将移除这档本地权重。已安装的其他权重仍可使用。</p>
          <p v-else>此功能将从快捷面板停用。之后可以重新安装。</p>
          <div class="dialog-actions">
            <button class="button button-light" @click="removal = null">取消</button>
            <button class="button button-danger" @click="confirmRemoval">移除</button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  </main>
</template>
