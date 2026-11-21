import { join, win32 } from 'node:path'
import type { Intent } from '../../src/shared/intent'
import { normalizeName } from '../../src/shared/intent'
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
const catalog = new ApplicationCatalog(join(directory, 'application-catalog-v2.json'))
const everything = new Everything(join(directory, 'everything'), (state) => parent.postMessage({ event: 'service', service: 'everything', state }))
const jobs = new Map<number, AbortController>()

async function search(intent: Intent, useEverything: boolean, signal: AbortSignal): Promise<PluginResult> {
  await everything.setEnabled(useEverything)
  const noApps: { exact: WindowsApp[]; candidates: WindowsApp[]; queried: boolean } = {
    exact: [], candidates: [], queried: false,
  }
  const appSearch = intent.kind === 'find_file' ? Promise.resolve(noApps)
    : catalog.find(intent.query, intent.kind === 'open_app').then((apps) => ({ ...apps, queried: true })).catch(() => noApps)
  const fileSearch = everything.find(intent.query, signal, intent.kind === 'open_app').then(async (result) => {
    if (result !== null) return { files: result, source: 'everything' as const }
    const fallbackReason = everything.fallbackReason()
    if (intent.kind === 'open_app') return { files: [], fallbackReason }
    try {
      return { files: await findFiles(intent.query, signal), source: 'windows-search' as const, fallbackReason }
    } catch {
      return { files: [], fallbackReason: `${fallbackReason}，Windows Search 也未能完成查询` }
    }
  })
  const [apps, { files, source, fallbackReason }] = await Promise.all([appSearch, fileSearch])
  signal.throwIfAborted()
  const results: Candidate[] = apps.candidates
    .filter(({ appId, launch }) => launch === 'aumid' || classifyFile(appId) === 'portable')
    .map((entry) => ({ kind: 'app', title: entry.name, target: entry.appId, launch: entry.launch,
      detail: apps.candidates.some(({ name, appId }) => appId !== entry.appId && normalizeName(name) === normalizeName(entry.name))
        ? entry.appId : entry.launch === 'path' ? entry.appId : 'Windows 应用',
      canOpen: true, exact: apps.exact.includes(entry), source: 'apps',
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
  const registered = new Set(results.map(({ target }) => target.toLowerCase()))
  const seen = new Set(registered)
  for (const item of candidateFiles) {
    if (!item || seen.has(item.target.toLowerCase())) continue
    seen.add(item.target.toLowerCase())
    results.push(item)
  }
  const sources: SearchSource[] = []
  if (apps.queried) sources.push('apps')
  if (source) sources.push(source)
  return { candidates: results.slice(0, 40), sources, fallbackReason }
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
      case 'search': return search(data.intent, data.everything, controller.signal)
    }
  })().then(
    (value) => parent.postMessage({ id: data.id, ok: true, value }),
    () => parent.postMessage({ id: data.id, ok: false, message: '快速搜索操作未完成。' }),
  ).finally(() => jobs.delete(data.id))
})
