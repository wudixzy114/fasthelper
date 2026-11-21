import { createApp, defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Launcher from './Launcher.vue'
import Settings from './Settings.vue'
import MainLayout from './MainLayout.vue'
import PluginWorkspace from './PluginWorkspace.vue'
import './style.css'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/launcher', name: 'launcher', component: Launcher },
    {
      path: '/', component: MainLayout, children: [
        { path: '', redirect: '/settings' },
        { path: 'settings', name: 'overview', component: Settings },
        { path: 'settings/features', name: 'features', component: Settings },
        { path: 'settings/model', name: 'model', component: Settings },
        { path: 'plugins/:pluginId/:pageId?', name: 'plugin', component: PluginWorkspace },
      ],
    },
  ],
})

createApp(defineComponent({ render: () => h(RouterView) }))
  .use(createPinia())
  .use(router)
  .mount('#app')
