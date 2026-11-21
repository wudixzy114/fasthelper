import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, screen,
  session, shell, Tray, type IpcMainInvokeEvent, type WebContents,
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { features, ipc, modelOptions, type ActionResponse, type ModelId, type PluginServiceAction, type SettingsSnapshot } from '../shared/contracts'
import { searchPluginId } from '../shared/plugin-contract'
import { SettingsStore, isFeatureStatus, sanitizeAliases } from './settings'
import { ModelInstaller } from './models'
import { LanguageModel } from './language-model'
import { SearchService } from './search'
import { SearchPlugin } from './plugin-manager'
import { Updates } from './updater'
import { ConversationService } from './conversation'
import { maxCommandLength } from '../shared/conversation'
import { speechOptions } from '../shared/speech'
import { SpeechInstaller } from './speech-models'
import { SpeechEngine } from './speech-engine'
import { EdgeDock } from './edge-dock'

const rendererPath = join(__dirname, '../renderer/index.html')
const rendererUrl = pathToFileURL(rendererPath).href
const devUrl = process.env.ELECTRON_RENDERER_URL
const iconPath = join(app.getAppPath(), 'build', 'icon.png')
const globalKey = 'Control+Shift+Space'
let registeredShortcut: string | null = null
let tray: Tray
let launcher: BrowserWindow | undefined
let dock: EdgeDock | undefined
let settings: BrowserWindow | undefined
let quitting = false
let store: SettingsStore
let installer: ModelInstaller
let language: LanguageModel
let search: SearchService
let conversation: ConversationService
let speechInstaller: SpeechInstaller
let speech: SpeechEngine
let plugin: SearchPlugin
let updates: Updates
let distribution: { pluginKey: string; pluginUrl: string | null; updateUrl: string | null }
let changingPlugin = false
let modelCommandPending = false
let switchingModel = false
let speechChanging = false

if (!app.isPackaged && process.env.FASTHELPER_TEST_PROFILE) {
  app.setPath('userData', process.env.FASTHELPER_TEST_PROFILE)
}
app.setAppUserModelId('com.fasthelper.desktop')

function activeModel(): ModelId | null {
  const preferred = store.preferredModel()
  if (preferred && installer.installed(preferred)) return preferred
  return modelOptions.find(({ id }) => installer.installed(id))?.id ?? null
}

function pluginDescriptor() {
  return plugin.descriptor((key, defaultValue) => store.pluginToggle(searchPluginId, key, defaultValue))
}

function activeSpeechModel() {
  const selected = store.speechModel()
  return selected && speechInstaller.installed(selected) ? selected : null
}

const searchSession = (id: number) => 'conversation:' + id

function getSnapshot(): SettingsSnapshot {
  const descriptor = pluginDescriptor()
  return {
    features: { 'quick-search': plugin.installed()
      ? store.snapshot()['quick-search'] === 'enabled' ? 'enabled' : 'disabled' : 'available' },
    pluginInstalling: plugin.installing(), pluginOnline: !!distribution.pluginUrl,
    plugins: descriptor ? [descriptor] : [], pluginUpdateRequired: plugin.updateRequired,
    update: updates.snapshot(), models: installer.snapshot(), activeModel: activeModel(),
    retiredLegacyPackage: installer.retiredLegacyPackage, legacyCleanupPending: installer.legacyCleanupPending,
    shortcut: registeredShortcut,
    speech: { models: speechInstaller.snapshot(), active: activeSpeechModel() },
  }
}

function publishSettings() {
  for (const window of [launcher, settings]) {
    if (window && !window.isDestroyed()) window.webContents.send(ipc.settingsChanged, getSnapshot())
  }
}

function trustedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    if (devUrl) return parsed.origin === new URL(devUrl).origin && parsed.pathname === '/'
    return parsed.href === rendererUrl
  } catch { return false }
}

function createWindow(route: string, useLauncher: boolean) {
  const window = new BrowserWindow({
    title: 'fasthelper',
    icon: iconPath,
    width: useLauncher ? 656 : 1032,
    height: useLauncher ? 218 : 730,
    minWidth: useLauncher ? 1 : 725,
    minHeight: useLauncher ? 1 : 594,
    show: false,
    backgroundColor: '#f7f8f5',
    autoHideMenuBar: true,
    frame: !useLauncher,
    resizable: !useLauncher,
    alwaysOnTop: useLauncher,
    skipTaskbar: useLauncher,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const sessionId = window.webContents.id
  window.once('closed', () => {
    search.clear(sessionId)
    conversation.clear(sessionId)
    speech.cancel(sessionId)
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedUrl(url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!trustedUrl(url)) event.preventDefault()
  })
  if (!useLauncher) window.once('ready-to-show', () => window.show())
  loadRoute(window, route)
  return window
}

function loadRoute(window: BrowserWindow, route: string) {
  if (devUrl) void window.loadURL(new URL(`#${route}`, devUrl).href)
  else void window.loadFile(rendererPath, { hash: route })
}

function showSettings(route?: string) {
  if (settings) {
    if (route && !settings.webContents.getURL().endsWith('#' + route)) loadRoute(settings, route)
    if (settings.isMinimized()) settings.restore()
    settings.show()
    settings.focus()
    return
  }
  settings = createWindow(route ?? '/home', false)
  settings.once('closed', () => { settings = undefined })
}

function hideLauncher() {
  dock?.collapse(true)
}

function prepareLauncher() {
  const window = createWindow('/launcher', true)
  launcher = window
  const owner = window.webContents.id
  dock = new EdgeDock(window, (expanded) => {
    if (!expanded) {
      conversation.clear(owner)
      speech.cancel(owner)
    }
    window.webContents.send(ipc.launcherChanged, expanded)
  })
  window.once('ready-to-show', () => { if (!dock?.expanded) dock?.collapse() })
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); hideLauncher() }
  })
  window.once('closed', () => { launcher = undefined; dock = undefined })
}

function showLauncher() {
  if (!launcher) prepareLauncher()
  dock?.show(true, true)
}

function trustedSender(contents: WebContents, frame: Electron.WebFrameMain | null) {
  const sender = BrowserWindow.fromWebContents(contents)
  return frame && !frame.parent && trustedUrl(frame.url) && sender && (sender === launcher || sender === settings) ? sender : null
}

function microphoneAllowed(contents: WebContents | null, requestUrl?: string) {
  if (!contents || !requestUrl || !trustedUrl(requestUrl) || !trustedUrl(contents.getURL())) return false
  const sender = BrowserWindow.fromWebContents(contents)
  return (sender === launcher || sender === settings) && speech.allowed(contents.id)
}

function registerHandlers() {
  function handleWindow<T>(
    channel: string, callback: (sender: BrowserWindow, ...args: unknown[]) => T, launcherOnly = false,
  ) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const sender = trustedSender(event.sender, event.senderFrame)
      if (!sender || (launcherOnly && sender !== launcher)) {
        throw new Error('无效的请求来源。')
      }
      return callback(sender, ...args)
    })
  }
  function handle<T>(channel: string, callback: (...args: unknown[]) => T, launcherOnly = false) {
    handleWindow(channel, (_sender, ...args) => callback(...args), launcherOnly)
  }

  handle(ipc.settings, getSnapshot)
  handle(ipc.setFeature, async (id, status) => {
    const feature = features.find((item) => item.id === id)
    if (!feature || !isFeatureStatus(status)) throw new Error('无法识别功能设置。')
    if (changingPlugin) throw new Error('快速搜索操作正在进行。')
    changingPlugin = true
    conversation.clear()
    search.clear()
    try {
      if (status === 'enabled' && !plugin.installed()) {
        if (distribution.pluginUrl) await plugin.install(() => plugin.download(distribution.pluginUrl!))
        else {
          const selected = await dialog.showOpenDialog({
            title: '导入快速搜索插件', properties: ['openFile'],
            filters: [{ name: 'fasthelper 插件包', extensions: ['fhplugin'] }],
          })
          const filename = selected.filePaths[0]
          if (selected.canceled || !filename) return getSnapshot()
          await plugin.install(() => plugin.readLocal(filename))
        }
      }
      if (status === 'available') await plugin.uninstall()
      await store.set(feature.id, status)
      search.clear()
      if (status === 'disabled') await plugin.stop()
      if (status === 'enabled') void plugin.warm().catch(() => undefined)
    } finally {
      changingPlugin = false
      publishSettings()
    }
    return getSnapshot()
  })
  handle(ipc.pluginService, async (id, service, action) => {
    if (id !== searchPluginId || typeof service !== 'string'
      || !['enable', 'disable', 'remove', 'check', 'cancel', 'open'].includes(String(action))) {
      throw new Error('插件服务操作无效。')
    }
    if (!plugin.installed() || changingPlugin || store.snapshot()[searchPluginId] !== 'enabled') {
      throw new Error('请先启用快速搜索。')
    }
    if (service === 'everything' && action === 'check') await plugin.checkServices(store.everythingEnabled())
    else {
      await plugin.service(service, action as PluginServiceAction)
      if (service === 'everything' && (action === 'enable' || action === 'disable' || action === 'remove')) {
        await store.setEverything(action === 'enable')
      }
    }
    publishSettings()
    return getSnapshot()
  })
  handle(ipc.pluginToggle, async (id, toggle, enabled) => {
    const declared = pluginDescriptor()?.pages.some((page) => page.view === 'settings'
      && page.toggles?.some((entry) => entry.id === toggle))
    if (id !== searchPluginId || typeof toggle !== 'string' || typeof enabled !== 'boolean'
      || !declared || changingPlugin || store.snapshot()[searchPluginId] !== 'enabled') {
      throw new Error('该插件设置不可用。')
    }
    await store.setPluginToggle(id, toggle, enabled)
    publishSettings()
    return getSnapshot()
  })
  handle(ipc.update, async (action) => {
    if (action === 'check') await updates.check()
    else if (action === 'install') updates.install()
    else throw new Error('更新操作无效。')
  })
  handle(ipc.savedApplication, (id, action) => {
    if (typeof id !== 'string' || id.length !== 36 || (action !== 'relocate' && action !== 'remove')) {
      throw new Error('已添加应用操作无效。')
    }
    return search.manageSaved(id, action)
  })
  handle(ipc.savedAliases, (id, value) => {
    const aliases = sanitizeAliases(value)
    if (typeof id !== 'string' || id.length !== 36 || !aliases || changingPlugin) {
      throw new Error('已添加应用的别名无效。')
    }
    return search.saveAliases(id, aliases)
  })
  handle(ipc.pluginCollection, (id, collection) => {
    const allowed = pluginDescriptor()?.pages.some((page) => page.view === 'settings'
      && page.collections?.some((entry) => entry.id === collection && entry.view === 'saved-applications'))
    if (id !== searchPluginId || !allowed || store.snapshot()[searchPluginId] !== 'enabled') {
      throw new Error('该插件列表不可用。')
    }
    return search.listSaved()
  })
  handle(ipc.manageModel, async (id, action) => {
    const model = modelOptions.find((option) => option.id === id)
    if (!model) throw new Error('无法识别模型。')
    if (modelCommandPending) throw new Error('另一个模型操作正在进行。')
    modelCommandPending = true
    try {
      const active = activeModel()
      switch (action) {
        case 'install': {
          if (installer.busy()) throw new Error('另一个模型操作正在进行。')
          const preferred = active ?? model.id
          if (store.preferredModel() !== preferred) await store.setPreferredModel(preferred)
          installer.install(model.id)
          break
        }
        case 'cancel': installer.cancel(model.id); break
        case 'remove':
          switchingModel = active === model.id
          await installer.remove(model.id, () => switchingModel ? language.stop() : Promise.resolve())
          break
        case 'activate':
          if (!installer.installed(model.id)) throw new Error('请先安装该模型。')
          if (active !== model.id) {
            switchingModel = true
            await language.stop()
          }
          if (store.preferredModel() !== model.id) await store.setPreferredModel(model.id)
          publishSettings()
          break
        default: throw new Error('无法识别模型操作。')
      }
    } finally {
      switchingModel = false
      modelCommandPending = false
    }
    return getSnapshot()
  })
  handle(ipc.testModel, async (): Promise<ActionResponse> => {
    if (!activeModel()) return { ok: false, message: '请先安装本地模型。' }
    try {
      const result = await language.rank('打开记事本', [
        { title: '记事本', detail: '文本编辑器', kind: 'app' },
        { title: '画图', detail: '图片编辑器', kind: 'app' },
      ], AbortSignal.timeout(90_000))
      if (result) return { ok: true }
      return { ok: false, message: '本地模型未返回完整的候选评分。请稍后重试。' }
    } catch {
      return { ok: false, message: '本地推理未完成。请检查系统资源后重试。' }
    }
  })
  handle(ipc.modelSource, (id) => {
    const model = modelOptions.find((option) => option.id === id)
    if (!model) throw new Error('无法识别模型。')
    return shell.openExternal(model.source)
  })
  handle(ipc.manageSpeechModel, async (id, action) => {
    const model = speechOptions.find((entry) => entry.id === id)
    if (!model || speechChanging) throw new Error('语音模型操作无效或正在进行。')
    speechChanging = true
    try {
      switch (action) {
        case 'install':
          if (speechInstaller.busy()) throw new Error('语音模型正在处理。')
          if (!store.speechModel()) await store.setSpeechModel(model.id)
          speechInstaller.install(model.id)
          break
        case 'cancel': speechInstaller.cancel(model.id); break
        case 'activate':
          if (!speechInstaller.installed(model.id)) throw new Error('请先安装语音模型。')
          if (store.speechModel() !== model.id) {
            await speech.stop()
            await store.setSpeechModel(model.id)
          }
          break
        case 'remove':
          await speechInstaller.remove(model.id, () => store.speechModel() === model.id ? speech.stop() : Promise.resolve())
          if (store.speechModel() === model.id) await store.setSpeechModel(null)
          break
        default: throw new Error('语音模型操作无效。')
      }
    } finally { speechChanging = false; publishSettings() }
    return getSnapshot()
  })
  handle(ipc.disableSpeechModel, async () => {
    if (speechChanging) throw new Error('语音模型正在处理。')
    speechChanging = true
    try {
      await speech.stop()
      await store.setSpeechModel(null)
    } finally { speechChanging = false; publishSettings() }
    return getSnapshot()
  })
  handleWindow(ipc.beginSpeech, (sender) => {
    if (speechChanging || (sender === launcher && !dock?.expanded)) throw new Error('当前无法开始语音输入。')
    return speech.begin(sender.webContents.id)
  })
  ipcMain.on(ipc.pushSpeech, (event, id, samples) => {
    if (trustedSender(event.sender, event.senderFrame) && typeof id === 'string' && id.length === 36) {
      speech.push(event.sender.id, id, samples)
    }
  })
  handleWindow(ipc.finishSpeech, (sender, id) => { if (typeof id === 'string') speech.finish(sender.webContents.id, id) })
  handleWindow(ipc.cancelSpeech, (sender, id) => { if (typeof id === 'string') speech.cancel(sender.webContents.id, id) })
  handle(ipc.openSettings, () => { hideLauncher(); showSettings('/settings') })
  handle(ipc.showLauncher, showLauncher)
  handle(ipc.hideLauncher, hideLauncher, true)
  handle(ipc.launcherState, () => !!dock?.expanded, true)
  handle(ipc.holdLauncher, (held) => {
    if (dock?.expanded && typeof held === 'boolean') dock.held = held
  }, true)
  handle(ipc.resizeLauncher, (height) => {
    if (typeof height !== 'number' || !Number.isSafeInteger(height)) return
    dock?.resize(height)
  }, true)
  handleWindow(ipc.converse, (sender, text, stage) => {
    if (typeof text !== 'string' || text.length > maxCommandLength || (stage !== 'preview' && stage !== 'submit')) {
      throw new Error('指令内容无效。')
    }
    return conversation.input(sender.webContents.id, text, stage)
  })
  handleWindow(ipc.choosePlugin, (sender, token) => {
    if (typeof token !== 'string' || token.length !== 36) throw new Error('插件候选无效。')
    return conversation.choose(sender.webContents.id, token)
  })
  handleWindow(ipc.cancelConversation, (sender) => conversation.clear(sender.webContents.id))
  handleWindow(ipc.openConversationResult, (sender, id, action) => {
    if (typeof id !== 'string' || id.length !== 36 || (action !== 'open' && action !== 'reveal' && action !== 'add')) {
      throw new Error('结果操作无效。')
    }
    return search.open(searchSession(sender.webContents.id), id, action)
  })
  handleWindow(ipc.search, (sender, id, query, commit) => {
    if (id !== searchPluginId || typeof query !== 'string' || query.length > 250 || typeof commit !== 'boolean') {
      throw new Error('搜索内容无效。')
    }
    if (changingPlugin) return { results: [], sources: [], notices: ['快速搜索正在更新设置，请稍后重试。'] }
    return search.query(sender.webContents.id, { text: query, stage: commit ? 'submit' : 'preview' })
  })
  handleWindow(ipc.closeSearch, (sender, id) => {
    if (id === searchPluginId) search.clear(sender.webContents.id)
  })
  handleWindow(ipc.openResult, (sender, id, action) => {
    if (typeof id !== 'string' || id.length !== 36 || (action !== 'open' && action !== 'reveal' && action !== 'add')) {
      throw new Error('结果操作无效。')
    }
    return search.open(sender.webContents.id, id, action)
  })
}

async function initialize() {
  const dataDirectory = app.getPath('userData')
  distribution = JSON.parse(await readFile(join(app.getAppPath(), 'build', 'distribution.json'), 'utf8'))
  store = new SettingsStore(join(dataDirectory, 'settings-v1.json'))
  installer = new ModelInstaller(join(dataDirectory, 'models'), (input, init) => net.fetch(input, init), publishSettings)
  speechInstaller = new SpeechInstaller(join(dataDirectory, 'speech'), (input, init) => net.fetch(input, init), publishSettings)
  speech = new SpeechEngine(() => {
    const id = activeSpeechModel()
    return id && !speechChanging ? speechInstaller.configuration(id) : null
  }, (id, event) => {
    const window = [launcher, settings].find((entry) => entry?.webContents.id === id)
    window?.webContents.send(ipc.speechEvent, event)
  })
  language = new LanguageModel(() => {
    const id = activeModel()
    return id && !switchingModel ? installer.configuration(id) : null
  })
  plugin = new SearchPlugin(join(dataDirectory, 'plugins', 'quick-search'), distribution.pluginKey, publishSettings)
  updates = new Updates(distribution.updateUrl, publishSettings)
  search = new SearchService(store, plugin, language)
  conversation = new ConversationService(() => {
    if (changingPlugin || store.snapshot()[searchPluginId] !== 'enabled') return []
    const entry = pluginDescriptor()
    if (!entry?.capability) return []
    return [{
      id: entry.id, title: entry.name, capability: entry.capability,
      run: async (id, text, stage) => ({
        kind: 'search', title: entry.name, preview: stage === 'preview',
        response: await search.query(searchSession(id), { text, stage }),
      }),
    }]
  }, (text, options, signal) => language.scoreRoutes(text, options, signal), (id) => {
    if (id !== undefined) search.clear(searchSession(id))
    else search.clear()
  })
  await Promise.all([store.load(), installer.init(), speechInstaller.init()])
  await plugin.init(store.everythingEnabled())
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.length === 1
      && details.mediaTypes[0] === 'audio' && details.isMainFrame && microphoneAllowed(contents, details.requestingUrl)))
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && details.isMainFrame === true
      && microphoneAllowed(contents, details.requestingUrl))
  registerHandlers()
  if (plugin.installed() && store.snapshot()['quick-search'] === 'enabled') void plugin.warm().catch(() => undefined)
  if (globalShortcut.register(globalKey, () => {
    if (launcher?.isFocused()) hideLauncher()
    else showLauncher()
  })) registeredShortcut = 'Ctrl + Shift + Space'
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 })
  tray = new Tray(trayIcon)
  tray.setToolTip('fasthelper')
  tray.on('click', showLauncher)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开快捷面板', click: showLauncher },
    { label: '打开主窗口', click: () => showSettings() },
    { type: 'separator' },
    { label: '退出 fasthelper', click: () => app.quit() },
  ]))
  showSettings()
  prepareLauncher()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (search) showSettings() })
  app.on('window-all-closed', () => { /* The tray keeps the desktop app available. */ })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    installer?.cancel()
    speechInstaller?.cancel()
    conversation?.clear()
    search?.clear()
    globalShortcut.unregisterAll()
    void Promise.allSettled([language?.stop(), plugin?.stop(), speech?.stop()]).finally(() => app.quit())
  })
  void app.whenReady().then(initialize).catch((error: unknown) => {
    console.error(error)
    dialog.showErrorBox('fasthelper 无法启动', '请确认 fasthelper 有权限写入当前用户的数据目录，然后重新打开应用。')
    app.quit()
  })
}
