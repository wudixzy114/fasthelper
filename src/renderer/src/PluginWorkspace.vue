<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/vue'
import PluginServicePanel from './PluginServicePanel.vue'
import SearchPanel from './SearchPanel.vue'
import PluginSavedApplications from './PluginSavedApplications.vue'
import { useSettings } from './store'

const store = useSettings()
const route = useRoute()
const router = useRouter()
const api = window.fasthelper
const plugin = computed(() => store.snapshot?.plugins.find((entry) => entry.id === route.params.pluginId))
const enabled = computed(() => !!plugin.value && store.snapshot?.features[plugin.value.id] === 'enabled')
const pageIndex = computed(() => Math.max(0, plugin.value?.pages.findIndex((page) => page.id === route.params.pageId) ?? 0))
const services = computed(() => plugin.value?.pages.flatMap((page) => page.view === 'settings' ? page.services : []) ?? [])

function selectPage(index: number, replace = false) {
  const entry = plugin.value
  const page = entry?.pages[index]
  if (!entry || !page) return
  const target = { name: 'plugin', params: { pluginId: entry.id, pageId: page.id } }
  void (replace ? router.replace(target) : router.push(target))
}

watch([() => plugin.value?.id, () => route.params.pageId], () => {
  if (plugin.value && !plugin.value.pages.some((page) => page.id === route.params.pageId)) selectPage(0, true)
}, { immediate: true })
watch([() => plugin.value?.id, enabled], ([id, active]) => {
  if (id && active) {
    for (const service of services.value) {
      if (service.actions.includes('check')) void api.managePluginService(id, service.id, 'check').catch(() => undefined)
    }
  }
}, { immediate: true })
</script>

<template>
  <main class="settings-main plugin-workspace">
    <template v-if="plugin">
      <header class="page-header"><h1>{{ plugin.name }}</h1></header>
      <TabGroup :selected-index="pageIndex" @change="selectPage($event)">
        <TabList class="workspace-tabs" :aria-label="plugin.name + ' 页面'">
          <Tab v-for="page in plugin.pages" :key="page.id" class="workspace-tab">{{ page.title }}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel v-for="(page, index) in plugin.pages" :key="page.id" :unmount="false" class="workspace-panel">
            <p v-if="!enabled" class="feedback" role="status">请先在功能管理中启用此插件。</p>
            <template v-else-if="page.view === 'search'">
              <SearchPanel :key="plugin.id" :plugin-id="plugin.id" :active="index === pageIndex">
                <template #status>
                  <PluginServicePanel v-for="entry in services" :key="entry.id" :plugin-id="plugin.id"
                    :service="entry" :state="plugin.services[entry.id]" summary />
                </template>
              </SearchPanel>
            </template>
            <template v-else>
              <PluginServicePanel v-for="entry in page.services" :key="entry.id" :plugin-id="plugin.id"
                :service="entry" :state="plugin.services[entry.id]" />
              <PluginSavedApplications v-for="entry in page.collections" :key="entry.id" :plugin-id="plugin.id"
                :collection="entry" :active="index === pageIndex" />
            </template>
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </template>
    <template v-else>
      <header class="page-header"><h1>插件工作区</h1></header>
      <p class="feedback" role="status">{{ store.snapshot ? '请在功能管理中安装对应插件。' : '正在读取插件…' }}</p>
      <RouterLink v-if="store.snapshot" :to="{ name: 'features' }" class="button button-light">功能管理</RouterLink>
    </template>
  </main>
</template>
