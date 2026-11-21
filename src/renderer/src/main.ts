import { createApp, defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import Launcher from './Launcher.vue'
import Settings from './Settings.vue'
import MainLayout from './MainLayout.vue'
import PluginWorkspace from './PluginWorkspace.vue'
import Conversation from './Conversation.vue'
import SpeechSettings from './SpeechSettings.vue'
import './style.css'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/launcher', name: 'launcher', component: Launcher },
    {
      path: '/', component: MainLayout, children: [
        { path: '', redirect: '/home' },
        { path: 'home', name: 'home', component: Conversation },
        { path: 'settings', name: 'overview', component: Settings },
        { path: 'settings/features', name: 'features', component: Settings },
        { path: 'settings/model', name: 'model', component: Settings },
        { path: 'settings/speech', name: 'speech', component: SpeechSettings },
        { path: 'plugins/:pluginId/:pageId?', name: 'plugin', component: PluginWorkspace },
      ],
    },
  ],
})

createApp(defineComponent({ render: () => h(RouterView) }))
  .use(createPinia())
  .use(router)
  .mount('#app')
