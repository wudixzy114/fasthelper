import { join, win32 } from 'node:path'
import { normalizeName } from '../../src/shared/intent'
import { toFileSearch, type SearchPlan } from '../../src/shared/search-plan'
import type { Candidate, PluginResult, WorkerReply, WorkerRequest } from '../../src/shared/plugin-contract'
import type { SearchSource } from '../../src/shared/contracts'
import { accessibleEntry, canOpenFile, classifyFile } from '../../src/shared/file-results'
import { ApplicationCatalog } from './applications'
import { Everything } from './everything'
import { findFiles, type WindowsApp } from './windows'

const parent = (process as typeof process & {
  parentPort?: { postMessage(value: WorkerReply): void; on(event: 'message', fn: (event: { data: WorkerRequest }) => void): void }
}).parentPort
const directory = process.argv.at(-1)
if (!parent || !directory) throw new Error('快速搜索需要由 fasthelper 启动。')
const catalog = new ApplicationCatalog(join(directory, 'application-catalog-v3.json'))
const everything = new Everything(join(directory, 'everything'), (state) => parent.postMessage({ event: 'service', service: 'everything', state }))
const jobs = new Map<number, AbortController>()

async function search(plan: SearchPlan, verificationName: string | undefined, useEverything: boolean, signal: AbortSignal): Promise<PluginResult> {
  await everything.setEnabled(useEverything)
  const searchApps = plan.scope !== 'files' && !plan.extension && !plan.directory && !plan.modified
  const appSearch = searchApps
    ? Promise.all(plan.terms.map((term) => catalog.find(term, plan.scope === 'apps'))).catch(() => undefined)
    : Promise.resolve(undefined)
  const requested = toFileSearch(plan)
  const fileSearch = everything.find(requested, signal).then(async (result) => {
    if (result !== null) return { ...result, source: 'everything' as const }
    const fallbackReason = everything.fallbackReason()
    signal.throwIfAborted()
    try {
      return { ...await findFiles(requested, signal), source: 'windows-search' as const, fallbackReason }
    } catch {
      return { files: [], source: undefined, complete: false, fallbackReason: fallbackReason + '，Windows Search 也未能完成查询' }
    }
  })
  const [apps, indexed] = await Promise.all([appSearch, fileSearch])
  const { files, source, fallbackReason } = indexed
  signal.throwIfAborted()
  const registered = new Map<string, WindowsApp>()
  for (const app of apps?.flat() ?? []) {
    if (app.launch === 'aumid' || classifyFile(app.appId) === 'portable') registered.set(app.appId.toLowerCase(), app)
  }
  const entries = [...registered.values()]
  const results: Candidate[] = (await Promise.all(entries.slice(0, 40).map(async (entry) =>
    entry.launch === 'aumid' || await accessibleEntry(entry.appId) ? entry : null)))
    .filter((entry) => entry !== null)
    .map((entry) => ({ kind: 'app', title: entry.name, target: entry.appId, launch: entry.launch,
      detail: entries.some(({ name, appId }) => appId !== entry.appId && normalizeName(name) === normalizeName(entry.name))
        ? entry.appId : entry.launch === 'path' ? entry.appId : 'Windows 应用',
      canOpen: true, verifiedName: verificationName !== undefined && normalizeName(entry.name) === normalizeName(verificationName),
      source: 'apps',
    }))
  // Name matches from a whole-disk index are grouped by what the user can do with them.
  const candidateFiles = await Promise.all(files.map(async (file): Promise<Candidate | null> => {
    const folder = 'folder' in file && file.folder === true
    if (!source || !await accessibleEntry(file.path, folder)) return null
    const kind = folder ? 'folder' : classifyFile(file.path)
    return {
      kind, title: file.name || win32.basename(file.path), detail: file.path, target: file.path,
      date: file.date, canOpen: folder || canOpenFile(file.path) || kind === 'portable',
      canAdd: kind === 'portable' && /\.exe$/iu.test(file.path), source,
    }
  }))
  const seen = new Set(results.map(({ target }) => target.toLowerCase()))
  for (const item of candidateFiles) {
    if (!item || seen.has(item.target.toLowerCase())) continue
    seen.add(item.target.toLowerCase())
    results.push(item)
  }
  const sources: SearchSource[] = []
  if (apps) sources.push('apps')
  if (source) sources.push(source)
  return {
    candidates: results.slice(0, 40), sources, fallbackReason,
    complete: indexed.complete && (!searchApps || apps !== undefined) && entries.length <= 40 && results.length <= 40,
  }
}

parent.on('message', ({ data }) => {
  if (data.method === 'cancel') { jobs.get(data.queryId)?.abort(); return }
  const controller = new AbortController()
  jobs.set(data.id, controller)
  void (async () => {
    switch (data.method) {
      case 'warm': await catalog.warm(); return
      case 'shutdown': await everything.setEnabled(false); return
      case 'service':
        if (data.service !== 'everything') throw new Error('无法识别插件服务。')
        switch (data.action) {
          case 'enable': await everything.setEnabled(true); return
          case 'disable': await everything.setEnabled(false); return
          case 'remove': await everything.remove(); return
          case 'check': everything.check(); return
          case 'cancel': everything.cancel(); return
          case 'open': everything.open(); return
        }
      case 'search': return search(data.plan, data.verificationName, data.everything, controller.signal)
    }
  })().then(
    (value) => parent.postMessage({ id: data.id, ok: true, value }),
    () => parent.postMessage({ id: data.id, ok: false, message: '快速搜索操作未完成。' }),
  ).finally(() => jobs.delete(data.id))
})
