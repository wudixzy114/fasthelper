import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { modelOptions, type ModelId, type ModelState } from '../shared/contracts'

type Artifact = { url: string; bytes: number; sha256: string }
type FetchArtifact = (url: string, options: RequestInit) => Promise<Response>

const weights: Record<ModelId, Artifact> = {
  'qwen35-0.8b': {
    url: 'https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/004fd086eccea9f7cf867aa07ba328773beef81d/Qwen3.5-0.8B-Q4_0.gguf',
    bytes: modelOptions[0].weightsBytes,
    sha256: '57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf',
  },
  'qwen35-4b': {
    url: 'https://huggingface.co/ggml-org/Qwen3.5-4B-GGUF/resolve/8d43d974efc48399cb58957ad49c8b26bf5a109c/Qwen3.5-4B-Q4_K_M.gguf',
    bytes: modelOptions[1].weightsBytes,
    sha256: '217002fa8008ef4fc6d548353a3aebef055a96e6ff8e0e2c0953ef8254a89c14',
  },
}
const engine: Artifact = {
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12606/llama-b12606-bin-win-cpu-x64.zip',
  bytes: 25009049,
  sha256: '425eeb2a94a9600dadf369a7c9c7dd0141948921efc0fa9ec7872970fffc845d',
}

async function expandRuntime(archive: string, directory: string): Promise<void> {
  await mkdir(directory)
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  await new Promise<void>((resolve, reject) => {
    execFile(tar, ['-xf', archive, '-C', directory], { windowsHide: true, timeout: 60_000 },
      (error) => error ? reject(error) : resolve())
  })
}

export async function downloadVerified(options: {
  filename: string
  artifact: Artifact
  fetch: FetchArtifact
  signal: AbortSignal
  onBytes: (bytes: number) => void
}): Promise<void> {
  const { filename, artifact, signal } = options
  const stalled = new AbortController()
  const requestSignal = AbortSignal.any([signal, stalled.signal])
  const timer = setTimeout(() => stalled.abort(), 45_000)
  try {
    const response = await options.fetch(artifact.url, { signal: requestSignal })
    if (!response.ok || !response.body) {
      throw new Error(`下载源返回 HTTP ${response.status}。请稍后重试。`)
    }
    const digest = createHash('sha256')
    let received = 0
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        timer.refresh()
        received += chunk.byteLength
        if (received > artifact.bytes) return callback(new Error('下载文件超过预期大小。'))
        digest.update(chunk)
        options.onBytes(received)
        callback(null, chunk)
      },
    })
    const source = Readable.fromWeb(response.body as ReadableStream<Uint8Array>)
    await pipeline(source, verify, createWriteStream(filename, { flags: 'wx', flush: true }), {
      signal: requestSignal,
    })
    if (received !== artifact.bytes || digest.digest('hex') !== artifact.sha256) {
      throw new Error('文件完整性校验失败。请重新下载。')
    }
  } catch (error) {
    if (stalled.signal.aborted && !signal.aborted) {
      throw new Error('下载连接长时间无响应。请检查网络后重试。', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export class ModelInstaller {
  private readonly states: Record<ModelId, ModelState> = {
    'qwen35-0.8b': { status: 'available' },
    'qwen35-4b': { status: 'available' },
  }
  private operation?: { id: ModelId; controller?: AbortController }
  private readonly runtimeDirectory: string
  private runtimeReady = false
  retiredLegacyPackage = false
  legacyCleanupPending = false

  constructor(
    private readonly root: string,
    private readonly request: FetchArtifact,
    private readonly changed: () => void,
  ) {
    this.runtimeDirectory = join(root, 'llama-cpp-b12606-win-x64')
  }

  private directory(id: ModelId): string { return join(this.root, id) }
  private weightsPath(id: ModelId): string { return join(this.directory(id), 'model.gguf') }
  private get runtimePath(): string { return join(this.runtimeDirectory, 'llama-server.exe') }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && /^(?:\.staging-|\.removed-)[a-z0-9-]+$/iu.test(entry.name)) {
        await rm(join(this.root, entry.name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    const legacyPackage = 'qwen3-0.6b-q8_0-b12606'
    if (entries.some((entry) => entry.name === legacyPackage)) {
      await rm(join(this.root, legacyPackage), { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
        .then(() => { this.retiredLegacyPackage = true }, () => { this.legacyCleanupPending = true })
    }
    this.runtimeReady = await access(this.runtimePath).then(() => true, () => false)
    for (const { id } of modelOptions) {
      this.states[id] = { status: await this.isInstalled(id) ? 'installed' : 'available' }
    }
  }

  snapshot(): Record<ModelId, ModelState> { return { ...this.states } }

  installed(id: ModelId): boolean { return this.states[id].status === 'installed' }

  busy(): boolean { return !!this.operation }

  configuration(id: ModelId): LocalModelConfiguration | null {
    return this.installed(id) ? { id, runtimePath: this.runtimePath, weightsPath: this.weightsPath(id) } : null
  }

  install(id: ModelId): void {
    if (this.installed(id)) return
    if (this.operation) throw new Error('另一个模型操作正在进行。')
    const controller = new AbortController()
    this.operation = { id, controller }
    const needsRuntime = !this.runtimeReady
    const totalBytes = weights[id].bytes + (needsRuntime ? engine.bytes : 0)
    this.set(id, { status: 'downloading', receivedBytes: 0, totalBytes })
    void this.download(id, needsRuntime, totalBytes, controller.signal).then(
      () => this.finish(id, { status: 'installed' }),
      (error: unknown) => {
        if (controller.signal.aborted) return this.finish(id, { status: 'available' })
        const code = (error as NodeJS.ErrnoException).code
        const message = code === 'ENOSPC' ? '磁盘空间不足。请释放空间后重试。'
          : error instanceof TypeError ? '连接下载源失败。请检查网络后重试。'
          : error instanceof Error && /[\u3400-\u9fff]/u.test(error.message) ? error.message
          : '安装未完成。请检查网络或磁盘权限后重试。'
        this.finish(id, { status: 'error', message })
      },
    )
  }

  cancel(id?: ModelId): void {
    if (!id || this.operation?.id === id) this.operation?.controller?.abort()
  }

  async remove(id: ModelId, beforeRemove: () => Promise<void>): Promise<void> {
    if (this.operation) throw new Error('另一个模型操作正在进行。')
    if (!this.installed(id)) return
    this.operation = { id }
    this.set(id, { status: 'removing' })
    const removed = join(this.root, `.removed-${randomUUID()}`)
    try {
      await beforeRemove()
      await rename(this.directory(id), removed)
      await rm(removed, { recursive: true, force: true }).catch(() => undefined)
      this.finish(id, { status: 'available' })
    } catch {
      this.finish(id, { status: 'installed' })
      throw new Error('暂时无法移除模型。请稍后重试。')
    }
  }

  private set(id: ModelId, state: ModelState): void {
    this.states[id] = state
    this.changed()
  }

  private finish(id: ModelId, state: ModelState): void {
    this.operation = undefined
    this.set(id, state)
  }

  private async isInstalled(id: ModelId): Promise<boolean> {
    if (!this.runtimeReady) return false
    try {
      const file = await stat(this.weightsPath(id))
      return file.isFile() && file.size === weights[id].bytes
    } catch {
      return false
    }
  }

  private async download(id: ModelId, needsRuntime: boolean, totalBytes: number, signal: AbortSignal): Promise<void> {
    const disk = await statfs(this.root)
    if (disk.bavail * disk.bsize < totalBytes + 128 * 1024 * 1024) {
      throw new Error('磁盘空间不足。请释放空间后重试。')
    }
    const staging = await mkdtemp(join(this.root, '.staging-'))
    const modelDirectory = join(staging, 'model')
    const artifact = weights[id]
    let lastUpdate = 0
    const progress = (receivedBytes: number) => {
      const time = Date.now()
      if (time - lastUpdate < 120) return
      lastUpdate = time
      this.set(id, { status: 'downloading', receivedBytes, totalBytes })
    }
    try {
      await mkdir(modelDirectory)
      await downloadVerified({
        filename: join(modelDirectory, 'model.gguf'), artifact, fetch: this.request,
        signal, onBytes: progress,
      })
      if (needsRuntime) {
        const archive = join(staging, 'engine.zip')
        const extracted = join(staging, 'runtime')
        await downloadVerified({
          filename: archive, artifact: engine, fetch: this.request,
          signal, onBytes: (bytes) => progress(artifact.bytes + bytes),
        })
        this.set(id, { status: 'verifying' })
        await expandRuntime(archive, extracted)
        await access(join(extracted, 'llama-server.exe'))
        signal.throwIfAborted()
        await rm(this.runtimeDirectory, { recursive: true, force: true })
        await rename(extracted, this.runtimeDirectory)
        this.runtimeReady = true
      }
      this.set(id, { status: 'verifying' })
      await access(this.runtimePath).catch((error) => { this.runtimeReady = false; throw error })
      signal.throwIfAborted()
      await rm(this.directory(id), { recursive: true, force: true })
      await rename(modelDirectory, this.directory(id))
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export type LocalModelConfiguration = { id: ModelId; weightsPath: string; runtimePath: string }
