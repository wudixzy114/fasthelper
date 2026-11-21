import { contextBridge, ipcRenderer } from 'electron'
import { ipc, type FasthelperApi, type SettingsSnapshot } from '../shared/contracts'
import type { SpeechEvent } from '../shared/speech'

const api: FasthelperApi = {
  settings: () => ipcRenderer.invoke(ipc.settings),
  onSettings(listener) {
    const receive = (_event: Electron.IpcRendererEvent, settings: SettingsSnapshot) => listener(settings)
    ipcRenderer.on(ipc.settingsChanged, receive)
    return () => ipcRenderer.removeListener(ipc.settingsChanged, receive)
  },
  setFeature: (id, status) => ipcRenderer.invoke(ipc.setFeature, id, status),
  managePluginService: (id, service, action) => ipcRenderer.invoke(ipc.pluginService, id, service, action),
  setPluginToggle: (id, toggle, enabled) => ipcRenderer.invoke(ipc.pluginToggle, id, toggle, enabled),
  manageUpdate: (action) => ipcRenderer.invoke(ipc.update, action),
  manageSavedApplication: (id, action) => ipcRenderer.invoke(ipc.savedApplication, id, action),
  setSavedApplicationAliases: (id, aliases) => ipcRenderer.invoke(ipc.savedAliases, id, aliases),
  listPluginCollection: (id, collection) => ipcRenderer.invoke(ipc.pluginCollection, id, collection),
  manageModel: (id, action) => ipcRenderer.invoke(ipc.manageModel, id, action),
  testModel: () => ipcRenderer.invoke(ipc.testModel),
  openModelSource: (id) => ipcRenderer.invoke(ipc.modelSource, id),
  openSettings: () => ipcRenderer.invoke(ipc.openSettings),
  showLauncher: () => ipcRenderer.invoke(ipc.showLauncher),
  hideLauncher: () => ipcRenderer.invoke(ipc.hideLauncher),
  launcherState: () => ipcRenderer.invoke(ipc.launcherState),
  onLauncherState(listener) {
    const receive = (_event: Electron.IpcRendererEvent, expanded: boolean) => listener(expanded)
    ipcRenderer.on(ipc.launcherChanged, receive)
    return () => ipcRenderer.removeListener(ipc.launcherChanged, receive)
  },
  holdLauncher: (held) => ipcRenderer.invoke(ipc.holdLauncher, held),
  resizeLauncher: (height) => ipcRenderer.invoke(ipc.resizeLauncher, height),
  converse: (text, stage) => ipcRenderer.invoke(ipc.converse, text, stage),
  choosePlugin: (token) => ipcRenderer.invoke(ipc.choosePlugin, token),
  cancelConversation: () => ipcRenderer.invoke(ipc.cancelConversation),
  openConversationResult: (id, action) => ipcRenderer.invoke(ipc.openConversationResult, id, action),
  manageSpeechModel: (id, action) => ipcRenderer.invoke(ipc.manageSpeechModel, id, action),
  disableSpeechModel: () => ipcRenderer.invoke(ipc.disableSpeechModel),
  beginSpeech: () => ipcRenderer.invoke(ipc.beginSpeech),
  pushSpeech: (id, samples) => ipcRenderer.send(ipc.pushSpeech, id, samples),
  finishSpeech: (id) => ipcRenderer.invoke(ipc.finishSpeech, id),
  cancelSpeech: (id) => ipcRenderer.invoke(ipc.cancelSpeech, id),
  onSpeech(listener) {
    const receive = (_event: Electron.IpcRendererEvent, speech: SpeechEvent) => listener(speech)
    ipcRenderer.on(ipc.speechEvent, receive)
    return () => ipcRenderer.removeListener(ipc.speechEvent, receive)
  },
  search: (id, query, commit) => ipcRenderer.invoke(ipc.search, id, query, commit),
  closeSearch: (id) => ipcRenderer.invoke(ipc.closeSearch, id),
  openResult: (id, action) => ipcRenderer.invoke(ipc.openResult, id, action),
}

contextBridge.exposeInMainWorld('fasthelper', api)
