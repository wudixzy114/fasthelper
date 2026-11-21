import { createHash, createPublicKey, verify } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { SearchPlan } from '../shared/search-plan'
import type { InstalledPlugin, PluginPage, PluginServiceAction, PluginServiceState } from '../shared/contracts'
import { pluginApiVersion, searchPluginId, type PluginResult, type WorkerReply, type WorkerRequest } from '../shared/plugin-contract'

type PluginManifest = Omit<InstalledPlugin, 'services' | 'toggles'> & { api: typeof pluginApiVersion; worker: string }
type Request = WorkerRequest extends infer Message
  ? Message extends WorkerRequest ? Omit<Message, 'id'> : never : never
const packageLimit = 2_000_000
const operationTimeout = 15_000

export class SearchPlugin {
  private payload?: PluginManifest
  private child?: UtilityProcess
  private nextId = 0
  private readonly pending = new Map<number, (reply: WorkerReply) => void>()
  private readonly file: string
  private entry?: string
  private busy = false
  private readonly services: Record<string, PluginServiceState> = {}
  updateRequired = false

  constructor(
    private readonly root: string, private readonly publicKey: string,
    private readonly changed: () => void,
  ) {
    this.file = join(root, 'quick-search.fhplugin')
  }

  installed(): boolean { return !!this.payload }
  installing(): boolean { return this.busy }
  descriptor(readToggle: (key: string, defaultValue: boolean) => boolean): InstalledPlugin | null {
    if (!this.payload) return null
    const { api: _api, worker: _worker, ...plugin } = this.payload
    const toggles = plugin.pages.flatMap((page) => page.view === 'settings' ? page.toggles ?? [] : [])
    return {
      ...plugin, services: { ...this.services },
      toggles: Object.fromEntries(toggles.map((item) => [item.id, readToggle(item.id, item.default)])),
    }
  }

  async init(enabled: boolean): Promise<void> {
    const managed = await access(join(this.root, 'everything', 'portable', 'everything.exe')).then(() => true, () => false)
    this.services.everything = { managed, enabled, status: enabled ? 'waiting' : 'off', installed: managed || undefined }
    try {
      if ((await stat(this.file)).size > packageLimit) return
      this.updateRequired = true
      const payload = this.validate(await readFile(this.file))
      this.entry = await this.writeWorker(payload.worker)
      this.payload = payload
      this.updateRequired = false
    } catch { /* A missing or rejected bundle stays uninstalled. */ }
  }

  async install(load: () => Promise<Buffer>): Promise<void> {
    if (this.busy) throw new Error('快速搜索操作正在进行。')
    this.busy = true
    this.changed()
    const staged = this.file + '.pending'
    try {
      const bytes = await load()
      const payload = this.validate(bytes)
      if (this.payload && compareVersions(payload.version, this.payload.version) < 0) throw new Error('插件包版本过低。')
      await this.stop()
      await mkdir(this.root, { recursive: true })
      await writeFile(staged, bytes, { flush: true })
      const entry = await this.writeWorker(payload.worker)
      await rename(staged, this.file)
      const previous = this.entry
      this.entry = entry
      this.payload = payload
      this.updateRequired = false
      if (previous && previous !== entry) await rm(previous, { force: true }).catch(() => undefined)
    } finally {
      await rm(staged, { force: true }).catch(() => undefined)
      this.busy = false
      this.changed()
    }
  }

  async readLocal(path: string): Promise<Buffer> {
    if ((await stat(path)).size > packageLimit) throw new Error('插件包超过大小限制。')
    return readFile(path)
  }

  async download(url: string): Promise<Buffer> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('插件下载地址无效。')
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok || !response.body) throw new Error('快速搜索下载失败。')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return Buffer.concat(chunks)
        size += value.byteLength
        if (size > packageLimit) throw new Error('插件包超过大小限制。')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
  }

  async stop(): Promise<void> {
    if (!this.child) return
    await this.call({ method: 'shutdown' }).catch(() => undefined)
    this.child?.kill()
    this.child = undefined
  }

  async uninstall(): Promise<void> {
    if (this.payload) {
      await this.service('everything', 'remove')
      await this.stop()
    }
    await rm(this.file, { force: true })
    this.payload = undefined
    this.updateRequired = false
    if (this.entry) await rm(this.entry, { force: true }).catch(() => undefined)
    this.entry = undefined
    this.changed()
  }

  warm(): Promise<PluginResult | undefined> { return this.call({ method: 'warm' }) }

  async service(service: string, action: PluginServiceAction): Promise<void> {
    const allowed = this.payload?.pages.some((page) =>
      page.view === 'settings' && page.services.some((entry) => entry.id === service && entry.actions.includes(action)))
    if (!allowed) throw new Error('该插件服务操作不可用。')
    await this.call({ method: 'service', service, action })
  }

  async checkServices(everythingEnabled: boolean): Promise<void> {
    if (!this.payload) return
    await this.service('everything', everythingEnabled ? 'enable' : 'disable')
    if (everythingEnabled) await this.service('everything', 'check')
  }

  async query(plan: SearchPlan, verificationName: string | undefined, everything: boolean, signal: AbortSignal): Promise<PluginResult> {
    return await this.call({ method: 'search', plan, verificationName, everything }, signal)
      ?? { candidates: [], sources: [], complete: false }
  }

  private validate(bytes: Buffer): PluginManifest {
    if (!this.publicKey || bytes.byteLength > packageLimit) throw new Error('当前版本缺少有效的插件签名配置。')
    const envelope = JSON.parse(bytes.toString('utf8'))
    if (typeof envelope?.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('插件包格式不正确。')
    const payload = Buffer.from(envelope.payload, 'base64')
    const signature = Buffer.from(envelope.signature, 'base64')
    if (!verify(null, payload, createPublicKey(this.publicKey), signature)) throw new Error('快速搜索插件签名校验失败。')
    const manifest = JSON.parse(payload.toString('utf8'))
    if (manifest?.id !== searchPluginId || manifest.api !== pluginApiVersion
      || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
      || typeof manifest.worker !== 'string' || !manifest.worker
      || typeof manifest.name !== 'string' || manifest.name.length > 40 || manifest.icon !== 'folder-search'
      || !validPages(manifest.pages)
      || (manifest.compactPage !== undefined && !manifest.pages.some((page: PluginPage) =>
        page.id === manifest.compactPage && page.view === 'search'))) throw new Error('插件与当前 fasthelper 不兼容。')
    return manifest
  }

  private start(): UtilityProcess {
    if (this.child) return this.child
    if (!this.payload || !this.entry) throw new Error('请先安装快速搜索。')
    const child = utilityProcess.fork(this.entry, [this.root], { serviceName: 'fasthelper 快速搜索', stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.on('data', (chunk: Buffer) => console.error(chunk.toString('utf8')))
    this.child = child
    child.on('message', (reply: WorkerReply) => {
      if ('event' in reply) {
        this.services[reply.service] = reply.state
        this.changed()
      } else this.pending.get(reply.id)?.(reply)
    })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      for (const receive of this.pending.values()) receive({ id: 0, ok: false, message: '快速搜索进程已退出。' })
    })
    return child
  }

  private async writeWorker(source: string): Promise<string> {
    const digest = createHash('sha256').update(source).digest('hex')
    const file = join(this.root, `worker-${digest}.cjs`)
    await writeFile(file, source, { flush: true })
    return file
  }

  private call(message: Request, signal?: AbortSignal): Promise<PluginResult | undefined> {
    signal?.throwIfAborted()
    const child = this.start()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        signal?.removeEventListener('abort', cancel)
      }
      const cancel = () => {
        clear()
        child.postMessage({ method: 'cancel', queryId: id })
        reject(signal?.reason ?? new Error('快速搜索超时。'))
      }
      const timer = setTimeout(cancel, operationTimeout)
      signal?.addEventListener('abort', cancel, { once: true })
      this.pending.set(id, (reply) => {
        clear()
        if ('ok' in reply && reply.ok) resolve(reply.value)
        else reject(new Error('message' in reply ? reply.message : '快速搜索请求失败。'))
      })
      child.postMessage({ ...message, id })
    })
  }
}

function validPages(value: unknown): value is PluginPage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return false
  const ids = new Set()
  const views = new Set()
  for (const page of value as PluginPage[]) {
    if (!page || !/^[a-z][a-z0-9-]{0,31}$/u.test(page.id) || typeof page.title !== 'string'
      || page.title.length > 32 || ids.has(page.id) || views.has(page.view)) return false
    ids.add(page.id)
    views.add(page.view)
    if (page.view === 'search') continue
    if (page.view !== 'settings' || !Array.isArray(page.services) || page.services.length > 8) return false
    if (!page.services.every((service) => service && /^[a-z][a-z0-9-]{0,31}$/u.test(service.id)
      && typeof service.title === 'string' && service.title.length <= 80 && Array.isArray(service.actions)
      && service.actions.every((action) => ['enable', 'disable', 'remove', 'check', 'cancel', 'open'].includes(action)))) return false
    if (page.collections !== undefined && (!Array.isArray(page.collections) || page.collections.length > 4
      || !page.collections.every((item) => item?.view === 'saved-applications' && /^[a-z][a-z0-9-]{0,31}$/u.test(item.id)
        && typeof item.title === 'string' && item.title.length <= 80))) return false
    if (page.toggles !== undefined && (!Array.isArray(page.toggles) || page.toggles.length > 8
      || !page.toggles.every((item) => item && /^[a-z][a-z0-9-]{0,31}$/u.test(item.id)
        && typeof item.title === 'string' && item.title.length <= 80
        && typeof item.description === 'string' && item.description.length <= 240
        && typeof item.default === 'boolean')
      || new Set(page.toggles.map(({ id }) => id)).size !== page.toggles.length)) return false
  }
  return true
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}
