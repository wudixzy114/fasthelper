import { randomUUID } from 'node:crypto'
import { dialog, shell } from 'electron'
import { normalizeName, readIntent, type Intent } from '../shared/intent'
import type { ActionResponse, SavedApplicationItem, SearchResponse, SearchResult, SearchSource } from '../shared/contracts'
import { accessibleEntry, canOpenFile, classifyFile } from '../shared/file-results'
import { launchApplication } from './windows'
import type { LanguageModel } from './language-model'
import type { SearchPlugin } from './plugin-manager'
import type { SettingsStore } from './settings'
import type { Candidate } from '../shared/plugin-contract'

type SearchItem = Candidate & Pick<SearchResult, 'missing' | 'savedId' | 'match'>
type Session = { request: AbortController; targets: Map<string, SearchItem> }

export class SearchService {
  private readonly sessions = new Map<number, Session>()

  constructor(
    private readonly settings: SettingsStore,
    private readonly plugin: SearchPlugin,
    private readonly language: Pick<LanguageModel, 'interpret' | 'rank'>,
  ) {}

  private enabled(): boolean {
    return this.plugin.installed() && this.settings.snapshot()['quick-search'] === 'enabled'
  }

  clear(id?: number): void {
    if (id !== undefined) {
      this.sessions.get(id)?.request.abort()
      this.sessions.delete(id)
    } else {
      for (const session of this.sessions.values()) session.request.abort()
      this.sessions.clear()
    }
  }

  async query(sessionId: number, input: string, commit: boolean): Promise<SearchResponse> {
    this.clear(sessionId)
    const request = new AbortController()
    const targets = new Map<string, SearchItem>()
    this.sessions.set(sessionId, { request, targets })
    const { signal } = request
    const response: SearchResponse = { results: [], notices: [], sources: [] }
    const text = input.trim()
    if (!text) return response
    if (!this.enabled()) return { ...response, notices: ['请在设置中安装或启用「快速搜索」。'] }

    try {
      const intent = readIntent(text)
      if (intent.kind === 'find_file' && !commit) return response
      let found = await this.find(intent, signal)
      let matches = found.items
      signal.throwIfAborted()
      const apps = matches.filter((item) => item.kind === 'app')
      if (commit && intent.kind === 'open_app' && intent.explicit
        && apps.length === 1 && apps[0].exact && !apps[0].missing) {
        const result = await this.act(apps[0], 'open')
        if (result.ok) return { ...response, sources: found.sources, fallbackReason: found.fallbackReason, opened: apps[0].title }
        response.notices.push(result.message)
      }

      if (commit) {
        const ranked = await this.language.rank(text, matches.filter((item) => !item.missing), signal).catch(() => null)
        signal.throwIfAborted()
        if (ranked) matches = [...ranked.results, ...matches.filter((item) => item.missing)]
        if (!matches.length || ranked?.uncertain) {
          const refined = await this.language.interpret(text, signal).catch(() => null)
          signal.throwIfAborted()
          if (refined && (refined.kind !== intent.kind || normalizeName(refined.query) !== normalizeName(intent.query))) {
            const alternative = await this.find({ ...refined, explicit: false }, signal)
            signal.throwIfAborted()
            if (alternative.items.length) {
              found = alternative
              const next = await this.language.rank(text, found.items.filter((item) => !item.missing), signal).catch(() => null)
              matches = next ? [...next.results, ...found.items.filter((item) => item.missing)] : found.items
            }
          }
        }
      }
      signal.throwIfAborted()
      if (!matches.length && !response.notices.length) {
        response.notices.push('当前索引中没有匹配结果。请检查名称或索引范围。')
      }
      response.results = matches.map(({ target, launch: _launch, exact: _exact, ...item }) => {
        const id = randomUUID()
        targets.set(id, { ...item, target, launch: _launch })
        return { ...item, id }
      })
      return { ...response, sources: found.sources, fallbackReason: found.fallbackReason }
    } catch {
      if (!signal.aborted) response.notices.push('快速搜索暂时不可用，请重试。')
      return response
    }
  }

  async open(sessionId: number, id: string, action: 'open' | 'reveal' | 'add'): Promise<ActionResponse> {
    const entry = this.sessions.get(sessionId)?.targets.get(id)
    if (!entry || !this.enabled()) return { ok: false, message: '结果已失效，请重新搜索。' }
    return this.act(entry, action)
  }

  async manageSaved(sessionId: number, id: string, action: 'relocate' | 'remove'): Promise<ActionResponse> {
    if (!this.enabled()) return { ok: false, message: '请先启用快速搜索。' }
    const app = this.settings.savedApplications().find((item) => item.id === id)
    if (!app) return { ok: false, message: '已添加的应用不存在。' }
    if (action === 'remove') await this.settings.removeApplication(id)
    else {
      const result = await dialog.showOpenDialog({
        title: `重新定位 ${app.name}`, properties: ['openFile'],
        filters: [{ name: 'Windows 应用', extensions: ['exe'] }],
      })
      const path = result.filePaths[0]
      if (result.canceled || !path) return { ok: false, message: '已取消重新定位。' }
      if (classifyFile(path) !== 'portable' || !await accessibleEntry(path)) {
        return { ok: false, message: '请选择可访问的应用程序。' }
      }
      await this.settings.saveApplication({ ...app, path })
    }
    this.clear(sessionId)
    return { ok: true }
  }

  listSaved(): Promise<SavedApplicationItem[]> {
    return Promise.all(this.settings.savedApplications().map(async (item) => ({
      ...item, missing: !await accessibleEntry(item.path),
    })))
  }

  private async find(intent: Intent, signal: AbortSignal): Promise<{ items: SearchItem[]; sources: SearchSource[]; fallbackReason?: string }> {
    const found = await this.plugin.query(intent, this.settings.everythingEnabled(), signal)
    if (intent.kind === 'find_file') return { ...found, items: found.candidates }
    const needle = normalizeName(intent.query)
    const saved = await Promise.all(this.settings.savedApplications().filter(({ name }) => normalizeName(name).includes(needle))
      .map(async (item): Promise<SearchItem> => {
        const exists = await accessibleEntry(item.path)
        return {
          kind: 'app', title: item.name, detail: item.path, target: item.path, launch: 'path',
          canOpen: exists, missing: !exists, savedId: item.id, exact: needle === normalizeName(item.name), source: 'saved-apps',
        }
      }))
    const paths = new Set(saved.map(({ target }) => target.toLowerCase()))
    return {
      items: [...saved, ...found.candidates.filter(({ target }) => !paths.has(target.toLowerCase()))],
      fallbackReason: found.fallbackReason,
      sources: saved.length ? [...found.sources, 'saved-apps' as const] : found.sources,
    }
  }

  private async act(entry: SearchItem, action: 'open' | 'reveal' | 'add'): Promise<ActionResponse> {
    try {
      if (entry.launch === 'aumid') {
        if (action !== 'open') return { ok: false, message: '此操作不适用于该结果。' }
        await launchApplication(entry.target)
        return { ok: true }
      }
      if (!await accessibleEntry(entry.target, entry.kind === 'folder')) {
        return { ok: false, message: '目标已移动、删除或不可访问。' }
      }
      if (action === 'reveal') shell.showItemInFolder(entry.target)
      else if (action === 'add') {
        if (!entry.canAdd || classifyFile(entry.target) !== 'portable' || !/\.exe$/iu.test(entry.target)) {
          return { ok: false, message: '该文件不能添加为应用。' }
        }
        const saved = this.settings.savedApplications().some(({ path }) => path.toLowerCase() === entry.target.toLowerCase())
        if (!saved) await this.settings.saveApplication({ id: randomUUID(), name: entry.title.replace(/\.exe$/iu, ''), path: entry.target })
      } else {
        const allowed = entry.kind === 'folder' || canOpenFile(entry.target)
          || (['app', 'portable'].includes(entry.kind) && classifyFile(entry.target) === 'portable')
        if (!entry.canOpen || !allowed) return { ok: false, message: '请在文件资源管理器中查看此文件。' }
        if (await shell.openPath(entry.target)) return { ok: false, message: 'Windows 无法打开该目标。' }
      }
      return { ok: true }
    } catch {
      return { ok: false, message: '无法完成操作，请重新搜索。' }
    }
  }
}
