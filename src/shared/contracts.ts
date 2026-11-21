export const features = [
  {
    id: 'quick-search',
    name: '快速搜索',
    description: '在一个面板中查找已安装应用、便携程序和本地文件。',
    example: '打开记事本 · 找上周的项目周报',
    detail: '独立插件 · Everything / Windows Search',
  },
] as const

export type FeatureId = (typeof features)[number]['id']
export type FeatureStatus = 'available' | 'enabled' | 'disabled'
export type FeatureStates = Record<FeatureId, FeatureStatus>

export const modelOptions = [
  {
    id: 'qwen35-0.8b',
    size: '0.8B',
    name: 'Qwen3.5-0.8B',
    quantization: 'Q4_0',
    weightsBytes: 563036064,
    description: '下载体积更小，适合日常应用启动与文件搜索。',
    source: 'https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF',
  },
  {
    id: 'qwen35-4b',
    size: '4B',
    name: 'Qwen3.5-4B',
    quantization: 'Q4_K_M',
    weightsBytes: 3032091584,
    description: '适合较复杂的口语指令，需要更多内存和推理时间。',
    source: 'https://huggingface.co/ggml-org/Qwen3.5-4B-GGUF',
  },
] as const

export type ModelId = (typeof modelOptions)[number]['id']
export type ModelAction = 'install' | 'cancel' | 'remove' | 'activate'
export type PluginServiceAction = 'enable' | 'disable' | 'remove' | 'check' | 'cancel' | 'open'
export type PluginServiceState = {
  enabled: boolean
  status: 'off' | 'waiting' | 'connecting' | 'downloading' | 'verifying' | 'starting'
    | 'indexing' | 'ready' | 'unavailable'
  installed?: boolean
  managed: boolean
  canOpen?: boolean
  version?: string
  checkedAt?: number
  since?: number
  error?: string
  progress?: { component: string; transferred: number; total: number }
}
export type PluginService = { id: string; title: string; actions: PluginServiceAction[] }
export type PluginCollection = { id: string; title: string; view: 'saved-applications' }
export type PluginToggle = { id: string; title: string; description: string; default: boolean }
export type PluginPage = { id: string; title: string } & (
  | { view: 'search' }
  | { view: 'settings'; services: PluginService[]; collections?: PluginCollection[]; toggles?: PluginToggle[] }
)
export type InstalledPlugin = {
  id: FeatureId
  name: string
  version: string
  icon: string
  pages: PluginPage[]
  compactPage?: string
  services: Record<string, PluginServiceState>
  toggles: Record<string, boolean>
}
export type SearchSource = 'apps' | 'saved-apps' | 'everything' | 'windows-search'
export const searchSourceLabels: Record<SearchSource, string> = {
  apps: 'Windows 应用目录', 'saved-apps': '已添加应用',
  everything: 'Everything', 'windows-search': 'Windows Search',
}
export type UpdateState = {
  version: string
  status: 'unconfigured' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'
  message?: string
  percent?: number
}
export type SearchKind = 'app' | 'file' | 'folder' | 'portable' | 'installer' | 'uninstaller' | 'helper'
export type SavedApplication = { id: string; name: string; path: string; aliases?: string[] }
export type SavedApplicationItem = SavedApplication & { missing: boolean }

export type ModelState =
  | { status: 'available' | 'installed' | 'verifying' | 'removing' }
  | { status: 'downloading'; receivedBytes: number; totalBytes: number }
  | { status: 'error'; message: string }

export type SettingsSnapshot = {
  features: FeatureStates
  pluginInstalling: boolean
  pluginOnline: boolean
  plugins: InstalledPlugin[]
  pluginUpdateRequired: boolean
  update: UpdateState
  models: Record<ModelId, ModelState>
  activeModel: ModelId | null
  retiredLegacyPackage: boolean
  legacyCleanupPending: boolean
  shortcut: string | null
}

export type SearchResult = {
  id: string
  kind: SearchKind
  title: string
  detail: string
  date?: string
  canOpen: boolean
  canAdd?: boolean
  missing?: boolean
  savedId?: string
  match?: 'high' | 'medium' | 'low'
  source: SearchSource
}

export type SearchResponse = {
  results: SearchResult[]
  notices: string[]
  sources: SearchSource[]
  fallbackReason?: string
  opened?: string
}

export type ActionResponse = { ok: true } | { ok: false; message: string }

export interface FasthelperApi {
  settings(): Promise<SettingsSnapshot>
  onSettings(listener: (settings: SettingsSnapshot) => void): () => void
  setFeature(id: FeatureId, status: FeatureStatus): Promise<SettingsSnapshot>
  managePluginService(id: FeatureId, service: string, action: PluginServiceAction): Promise<SettingsSnapshot>
  setPluginToggle(id: FeatureId, toggle: string, enabled: boolean): Promise<SettingsSnapshot>
  manageUpdate(action: 'check' | 'install'): Promise<void>
  manageSavedApplication(id: string, action: 'relocate' | 'remove'): Promise<ActionResponse>
  setSavedApplicationAliases(id: string, aliases: string[]): Promise<ActionResponse>
  listPluginCollection(id: FeatureId, collection: string): Promise<SavedApplicationItem[]>
  manageModel(id: ModelId, action: ModelAction): Promise<SettingsSnapshot>
  testModel(): Promise<ActionResponse>
  openModelSource(id: ModelId): Promise<void>
  openSettings(): Promise<void>
  showLauncher(): Promise<void>
  hideLauncher(): Promise<void>
  resizeLauncher(height: number): Promise<void>
  search(id: FeatureId, query: string, commit: boolean): Promise<SearchResponse>
  closeSearch(id: FeatureId): Promise<void>
  openResult(id: string, action: 'open' | 'reveal' | 'add'): Promise<ActionResponse>
}

export const ipc = {
  settings: 'settings:read',
  settingsChanged: 'settings:changed',
  setFeature: 'settings:feature',
  pluginService: 'plugins:service',
  pluginToggle: 'plugins:toggle',
  closeSearch: 'search:close',
  update: 'app:update',
  savedApplication: 'search:saved-app',
  savedAliases: 'search:saved-aliases',
  pluginCollection: 'plugins:collection',
  manageModel: 'models:manage',
  testModel: 'models:test',
  modelSource: 'models:source',
  openSettings: 'window:settings',
  showLauncher: 'window:launcher',
  hideLauncher: 'window:hide-launcher',
  resizeLauncher: 'window:resize-launcher',
  search: 'search:query',
  openResult: 'search:open',
} as const
