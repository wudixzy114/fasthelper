import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeName } from '../../src/shared/intent'
import { isAppId, scanApplications, type WindowsApp } from './windows'

const aliases: Record<string, string[]> = {
  'notepad': ['记事本'],
  'calculator': ['计算器'],
  'file explorer': ['资源管理器', '文件资源管理器'],
  'settings': ['设置'],
  'terminal': ['终端'],
  'microsoft edge': ['Edge'],
  'wechat': ['微信'],
  'wecom': ['企业微信'],
  'visual studio code': ['VS Code', 'VSCode'],
}

function namesOf(app: WindowsApp): string[] {
  const name = normalizeName(app.name)
  return [name, ...(Object.hasOwn(aliases, name) ? aliases[name].map(normalizeName) : [])]
}

function mentioned(phrase: string, name: string): boolean {
  if (name.length < 2 || !phrase.includes(name)) return false
  if (/\p{Script=Han}/u.test(name)) return true
  if (name.length < 3) return false
  const literal = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![a-z0-9])${literal}(?![a-z0-9])`, 'u').test(phrase)
}

export class ApplicationCatalog {
  private apps?: WindowsApp[]
  private pending?: Promise<WindowsApp[]>
  private refreshedAt = 0

  constructor(private readonly filename: string) {}

  async warm(): Promise<void> {
    await this.load()
  }

  async find(query: string, includeMentions = false): Promise<{ exact: WindowsApp[]; candidates: WindowsApp[] }> {
    const needle = normalizeName(query)
    if (!needle) return { exact: [], candidates: [] }
    const entries = await this.load()
    const exact: WindowsApp[] = []
    const partial: WindowsApp[] = []
    for (const entry of entries) {
      const keys = namesOf(entry)
      if (keys.includes(needle)) exact.push(entry)
      else if (keys.some((key) => key.includes(needle))) partial.push(entry)
    }
    if (exact.length || partial.length || !includeMentions) {
      return { exact, candidates: [...exact, ...partial].slice(0, 8) }
    }

    const terms = new Set(entries.flatMap(namesOf).filter((name) => mentioned(needle, name)))
    const mentionedTerms = [...terms]
    const direct = entries.filter((entry) => namesOf(entry).some((name) => terms.has(name)))
    const related = entries.filter((entry) =>
      !direct.includes(entry) && namesOf(entry).some((name) => mentionedTerms.some((term) => mentioned(name, term))))
    // A name mentioned inside a longer request can surface candidates only.
    return { exact: [], candidates: [...direct, ...related].slice(0, 8) }
  }

  private async load(): Promise<WindowsApp[]> {
    if (!this.apps) {
      try {
        const cached: unknown = JSON.parse(await readFile(this.filename, 'utf8'))
        if (Array.isArray(cached)) {
          this.apps = cached.filter((entry) =>
            typeof entry?.name === 'string' && isAppId(entry.appId) && ['aumid', 'path'].includes(entry.launch))
        }
      } catch { /* The system catalog can be rebuilt. */ }
    }
    if (Date.now() - this.refreshedAt > 300_000 && !this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = undefined })
    }
    if (this.apps) {
      void this.pending?.catch(() => undefined)
      return this.apps
    }
    return this.pending ?? []
  }

  private async refresh(): Promise<WindowsApp[]> {
    const entries = await scanApplications()
    const keys = new Set<string>()
    const unique = entries.filter((entry) => {
      const id = entry.appId.toLowerCase()
      const name = normalizeName(entry.name)
      if (keys.has(id) || (entry.launch === 'path' && keys.has(name))) return false
      keys.add(id)
      keys.add(name)
      return true
    })
    this.apps = unique.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    this.refreshedAt = Date.now()
    const staged = `${this.filename}.tmp`
    try {
      await mkdir(dirname(this.filename), { recursive: true })
      await writeFile(staged, JSON.stringify(this.apps), { flush: true })
      await rename(staged, this.filename)
    } catch {
      await rm(staged, { force: true }).catch(() => undefined)
    }
    return this.apps
  }
}
