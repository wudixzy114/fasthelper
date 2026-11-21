import { randomUUID } from 'node:crypto'
import { dialog, shell } from 'electron'
import { normalizeName } from '../shared/intent'
import { confirmedOpenName, literalSearch, searchTerms, type SearchPlan, type SearchStage } from '../shared/search-plan'
import type { ActionResponse, SavedApplicationItem, SearchResponse, SearchResult } from '../shared/contracts'
import { accessibleEntry, canOpenFile, classifyFile } from '../shared/file-results'
import { launchApplication, registeredApplicationName } from './windows'
import type { LanguageModel } from './language-model'
import type { SearchPlugin } from './plugin-manager'
import type { SettingsStore } from './settings'
import { autoOpenPreference, searchPluginId, type Candidate, type PluginResult } from '../shared/plugin-contract'

type SearchItem = Candidate & Pick<SearchResult, 'missing' | 'savedId' | 'match'>
type Session = { request: AbortController; targets: Map<string, SearchItem> }

function isApplication(item: SearchItem): boolean {
  return item.canOpen && !item.missing && (item.kind === 'app' || item.kind === 'portable')
}

function isSearchTarget(item: SearchItem, plan: SearchPlan): boolean {
  if (item.missing) return false
  const auxiliary = item.kind === 'installer' || item.kind === 'uninstaller' || item.kind === 'helper'
  if (auxiliary) return !!plan.extension || plan.terms.some((term) => classifyFile(term + '.exe') === item.kind)
  if (plan.scope === 'apps') return isApplication(item)
  if (item.kind === 'file' || item.kind === 'folder') return true
  return plan.scope === 'all' || !!plan.extension
}

export class SearchService {
  private readonly sessions = new Map<number, Session>()

  constructor(
    private readonly settings: SettingsStore,
    private readonly plugin: SearchPlugin,
    private readonly language: Pick<LanguageModel, 'interpret' | 'rank'>,
  ) {}

  private enabled(): boolean {
    return this.plugin.installed() && this.settings.snapshot()[searchPluginId] === 'enabled'
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

  async query(sessionId: number, input: { text: string; stage: SearchStage }): Promise<SearchResponse> {
    this.clear(sessionId)
    const request = new AbortController()
    const targets = new Map<string, SearchItem>()
    this.sessions.set(sessionId, { request, targets })
    const { signal } = request
    const response: SearchResponse = { results: [], notices: [], sources: [] }
    const text = input.text.trim()
    if (!text) return response
    if (!this.enabled()) return response

    try {
      const submitted = input.stage === 'submit'
      const generated = submitted ? await this.language.interpret(text, signal).catch(() => null) : null
      signal.throwIfAborted()
      const plan = generated ?? literalSearch(text)
      if (plan.action === 'clarify' || !plan.terms.length) {
        return { ...response, notices: ['请提供应用名、版本或文件名，再试一次。'] }
      }
      const verificationName = confirmedOpenName(text, plan)
      if (verificationName) plan.terms = searchTerms([verificationName, ...plan.terms])
      const found = await this.find(plan, verificationName, signal)
      signal.throwIfAborted()
      let matches = found.items
      const candidates = matches.filter((item) => isSearchTarget(item, plan))
      const [unique] = candidates
      const mayOpen = () => !signal.aborted && this.enabled()
        && this.settings.pluginToggle(searchPluginId, autoOpenPreference, true)
      if (verificationName && found.complete && candidates.length === 1 && unique.verifiedName && isApplication(unique) && mayOpen()) {
        const name = unique.launch === 'aumid' ? await registeredApplicationName(unique.target, signal).catch(() => '') : verificationName
        const result = normalizeName(name) === normalizeName(verificationName) && mayOpen()
          ? await this.act(unique, 'open', mayOpen) : { ok: false as const, message: '应用状态已变化，请在结果中确认。' }
        if (result.ok) return { ...response, sources: found.sources, fallbackReason: found.fallbackReason, opened: unique.title }
        signal.throwIfAborted()
        response.notices.push(result.message)
      }

      if (generated && candidates.length > 1) {
        const ranked = await this.language.rank(text, candidates, signal).catch(() => null)
        signal.throwIfAborted()
        if (ranked) matches = [...ranked.results, ...matches.filter((item) => !candidates.includes(item))]
      }
      signal.throwIfAborted()
      if (!matches.length && !response.notices.length) {
        response.notices.push(found.sources.length
          ? '当前索引中没有匹配结果。请检查名称或索引范围。' : '当前没有可用的搜索来源，请检查插件设置。')
      } else if (plan.scope === 'apps' && matches.length && !candidates.length) {
        response.notices.push('没有找到可打开的应用。下方保留相关条目。')
      }
      response.results = matches.map(({ target, launch, verifiedName: _verifiedName, ...item }) => {
        const id = randomUUID()
        targets.set(id, { ...item, target, launch })
        return { ...item, id }
      })
      return { ...response, sources: found.sources, fallbackReason: found.fallbackReason }
    } catch {
      if (!signal.aborted) response.notices.push('快速搜索暂时不可用，请重试。')
      return response
    }
  }

  async open(sessionId: number, id: string, action: 'open' | 'reveal' | 'add'): Promise<ActionResponse> {
    const session = this.sessions.get(sessionId)
    const entry = session?.targets.get(id)
    if (!session || !entry || !this.enabled()) return { ok: false, message: '结果已失效，请重新搜索。' }
    return this.act(entry, action, () => !session.request.signal.aborted && this.enabled())
  }

  async manageSaved(id: string, action: 'relocate' | 'remove'): Promise<ActionResponse> {
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
      await this.settings.updateApplication(id, { path })
    }
    this.clear()
    return { ok: true }
  }

  async saveAliases(id: string, aliases: string[]): Promise<ActionResponse> {
    if (!this.enabled() || !this.settings.savedApplications().some((item) => item.id === id)) {
      return { ok: false, message: '已添加的应用不存在。' }
    }
    await this.settings.updateApplication(id, { aliases })
    this.clear()
    return { ok: true }
  }

  listSaved(): Promise<SavedApplicationItem[]> {
    return Promise.all(this.settings.savedApplications().map(async (item) => ({
      ...item, missing: !await accessibleEntry(item.path),
    })))
  }

  private async find(plan: SearchPlan, verificationName: string | undefined, signal: AbortSignal):
    Promise<Omit<PluginResult, 'candidates'> & { items: SearchItem[] }> {
    const found = await this.plugin.query(plan, verificationName, this.settings.everythingEnabled(), signal)
    if (plan.scope === 'files' || plan.extension || plan.directory || plan.modified) return { ...found, items: found.candidates }
    const terms = plan.terms.map(normalizeName)
    const verified = verificationName ? normalizeName(verificationName) : ''
    const saved = await Promise.all(this.settings.savedApplications()
      .filter(({ name, aliases }) => [name, ...aliases ?? []].some((value) =>
        terms.some((term) => normalizeName(value).includes(term))))
      .map(async (item): Promise<SearchItem> => {
        const exists = await accessibleEntry(item.path)
        const verifiedName = !!verified && [item.name, ...item.aliases ?? []].some((value) => normalizeName(value) === verified)
        return {
          kind: 'app', title: item.name, detail: item.path, target: item.path, launch: 'path',
          canOpen: exists, missing: !exists, savedId: item.id, verifiedName, source: 'saved-apps',
        }
      }))
    const unique = new Map<string, SearchItem>()
    for (const item of [...saved, ...found.candidates]) {
      const key = item.target.toLowerCase()
      const previous = unique.get(key)
      unique.set(key, previous ? { ...previous, verifiedName: previous.verifiedName || item.verifiedName } : item)
    }
    return {
      items: [...unique.values()],
      complete: found.complete, fallbackReason: found.fallbackReason,
      sources: saved.length ? [...found.sources, 'saved-apps' as const] : found.sources,
    }
  }

  private async act(entry: SearchItem, action: 'open' | 'reveal' | 'add', allowedNow: () => boolean): Promise<ActionResponse> {
    try {
      if (entry.launch === 'aumid') {
        if (action !== 'open') return { ok: false, message: '此操作不适用于该结果。' }
        if (!allowedNow()) return { ok: false, message: '打开请求已取消。' }
        await launchApplication(entry.target)
        return { ok: true }
      }
      if (!await accessibleEntry(entry.target, entry.kind === 'folder')) {
        return { ok: false, message: '目标已移动、删除或不可访问。' }
      }
      if (!allowedNow()) return { ok: false, message: '操作请求已取消。' }
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
