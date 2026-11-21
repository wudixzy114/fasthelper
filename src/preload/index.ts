import { contextBridge, ipcRenderer } from 'electron'
import { ipc, type FasthelperApi, type SettingsSnapshot } from '../shared/contracts'

const api: FasthelperApi = {
  settings: () => ipcRenderer.invoke(ipc.settings),
  onSettings(listener) {
    const receive = (_event: Electron.IpcRendererEvent, settings: SettingsSnapshot) => listener(settings)
    ipcRenderer.on(ipc.settingsChanged, receive)
    return () => ipcRenderer.removeListener(ipc.settingsChanged, receive)
  },
  setFeature: (id, status) => ipcRenderer.invoke(ipc.setFeature, id, status),
  managePluginService: (id, service, action) => ipcRenderer.invoke(ipc.pluginService, id, service, action),
  manageUpdate: (action) => ipcRenderer.invoke(ipc.update, action),
  manageSavedApplication: (id, action) => ipcRenderer.invoke(ipc.savedApplication, id, action),
  listPluginCollection: (id, collection) => ipcRenderer.invoke(ipc.pluginCollection, id, collection),
  manageModel: (id, action) => ipcRenderer.invoke(ipc.manageModel, id, action),
  testModel: () => ipcRenderer.invoke(ipc.testModel),
  openModelSource: (id) => ipcRenderer.invoke(ipc.modelSource, id),
  openSettings: () => ipcRenderer.invoke(ipc.openSettings),
  showLauncher: () => ipcRenderer.invoke(ipc.showLauncher),
  hideLauncher: () => ipcRenderer.invoke(ipc.hideLauncher),
  resizeLauncher: (height) => ipcRenderer.invoke(ipc.resizeLauncher, height),
  search: (id, query, commit) => ipcRenderer.invoke(ipc.search, id, query, commit),
  closeSearch: (id) => ipcRenderer.invoke(ipc.closeSearch, id),
  openResult: (id, action) => ipcRenderer.invoke(ipc.openResult, id, action),
}

contextBridge.exposeInMainWorld('fasthelper', api)
