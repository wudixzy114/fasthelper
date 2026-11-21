import { mkdir, mkdtemp, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelState } from '../shared/contracts'
import { speechOptions, type SpeechModelId } from '../shared/speech'
import { downloadVerified, expandRuntime, type Artifact, type FetchArtifact } from './models'

type ModelFile = Artifact & { filename: string }
const source = 'https://huggingface.co/GilgameshWind/X-ASR-zh-en/resolve/689ff18c584d29910da37b6fe904db0c1489c9d1/deployment/models/chunk-480ms-model'
const modelFile = (filename: string, bytes: number, sha256: string): ModelFile =>
  ({ filename, bytes, sha256, url: source + '/' + filename + '?download=true' })
const models: Record<SpeechModelId, Record<'encoder' | 'decoder' | 'joiner' | 'tokens', ModelFile>> = {
  'xasr-zh-en-480ms': {
    encoder: modelFile('encoder-480ms.onnx', 592968361, '0c3454033d249081df124ddcd7adaf3deca07d0b999b26f2ee5d2475d37abc74'),
    decoder: modelFile('decoder-480ms.onnx', 11309084, '3658368d274a5d5fd39a7ac20c46bed0ad9cfea1f0feddef30d5d89797c1f499'),
    joiner: modelFile('joiner-480ms.onnx', 10260467, '03781c98165a2385024c9cecdd2b6b13310d81db23a62c7da420782c2915cf81'),
    tokens: modelFile('tokens.txt', 58806, 'b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c'),
  },
}
const runtime: Artifact = {
  url: 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-2.0.2.tgz',
  bytes: 9062542, sha256: 'b49c291b694277955b5a6a06dd6b0f7f328a437e0a345befd0f7454450738079',
}
const runtimeFiles = ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll']

export type SpeechConfiguration = {
  addon: string
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

export class SpeechInstaller {
  private readonly states = Object.fromEntries(speechOptions.map(({ id }) => [id, { status: 'available' }])) as Record<SpeechModelId, ModelState>
  private operation?: { id: SpeechModelId; controller?: AbortController }

  constructor(private readonly root: string, private readonly fetch: FetchArtifact, private readonly changed: () => void) {}

  async init() {
    await mkdir(this.root, { recursive: true })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.stage-[A-Za-z0-9]+$/u.test(entry.name)) {
        await rm(join(this.root, entry.name), { force: true, recursive: true }).catch(() => undefined)
      }
    }
    for (const { id } of speechOptions) {
      if (await this.present(join(this.root, id), id)) this.states[id] = { status: 'installed' }
    }
  }

  snapshot() { return { ...this.states } }
  installed(id: SpeechModelId) { return this.states[id].status === 'installed' }
  busy() { return this.operation !== undefined }

  configuration(id: SpeechModelId): SpeechConfiguration | null {
    if (!this.installed(id)) return null
    const path = join(this.root, id)
    const files = models[id]
    return {
      addon: join(path, 'runtime', 'package', 'sherpa-onnx.node'),
      encoder: join(path, files.encoder.filename), decoder: join(path, files.decoder.filename),
      joiner: join(path, files.joiner.filename), tokens: join(path, files.tokens.filename),
    }
  }

  install(id: SpeechModelId) {
    if (this.busy()) throw new Error('语音模型正在处理。')
    if (this.installed(id)) return
    const controller = new AbortController()
    this.operation = { id, controller }
    const totalBytes = runtime.bytes + Object.values(models[id]).reduce((total, file) => total + file.bytes, 0)
    this.set(id, { status: 'downloading', receivedBytes: 0, totalBytes })
    void this.download(id, totalBytes, controller.signal).then(
      () => { this.operation = undefined; this.set(id, { status: 'installed' }) },
      (error: unknown) => {
        this.operation = undefined
        this.set(id, controller.signal.aborted ? { status: 'available' } : {
          status: 'error', message: error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message)
            ? error.message : '无法安装语音模型，请检查下载连接和磁盘空间。',
        })
      },
    )
  }

  cancel(id?: SpeechModelId) {
    if (id === undefined || this.operation?.id === id) this.operation?.controller?.abort()
  }

  async remove(id: SpeechModelId, before: () => Promise<void>) {
    if (this.busy()) throw new Error('语音模型正在处理。')
    if (!this.installed(id)) return
    this.operation = { id }
    this.set(id, { status: 'removing' })
    try {
      await before()
      await rm(join(this.root, id), { recursive: true, force: true })
      this.set(id, { status: 'available' })
    } catch (error) {
      this.set(id, await this.present(join(this.root, id), id) ? { status: 'installed' } : { status: 'available' })
      throw error
    } finally { this.operation = undefined }
  }

  private async present(path: string, id: SpeechModelId) {
    const checked = await Promise.all([
      ...Object.values(models[id]).map(async ({ filename, bytes }) => {
        const info = await stat(join(path, filename))
        return info.isFile() && info.size === bytes
      }),
      ...runtimeFiles.map(async (name) => (await stat(join(path, 'runtime', 'package', name))).isFile()),
    ]).catch(() => [])
    return checked.length > 0 && checked.every(Boolean)
  }

  private set(id: SpeechModelId, state: ModelState) {
    this.states[id] = state
    this.changed()
  }

  private async download(id: SpeechModelId, totalBytes: number, signal: AbortSignal) {
    const disk = await statfs(this.root)
    if (disk.bavail * disk.bsize < totalBytes + 64_000_000) throw new Error('磁盘空间不足，无法安装语音模型。')
    const path = await mkdtemp(join(this.root, '.stage-'))
    let downloaded = 0
    let lastUpdate = 0
    try {
      for (const artifact of [...Object.values(models[id]), { ...runtime, filename: 'runtime.tgz' }]) {
        signal.throwIfAborted()
        await downloadVerified({
          filename: join(path, artifact.filename), artifact, fetch: this.fetch, signal,
          onBytes: (received) => {
            const now = Date.now()
            if (now - lastUpdate >= 160) {
              lastUpdate = now
              this.set(id, { status: 'downloading', receivedBytes: downloaded + received, totalBytes })
            }
          },
        })
        downloaded += artifact.bytes
      }
      this.set(id, { status: 'verifying' })
      const archive = join(path, 'runtime.tgz')
      await expandRuntime(archive, join(path, 'runtime'), signal)
      await rm(archive)
      if (!await this.present(path, id)) throw new Error('语音模型或运行时文件不完整。')
      signal.throwIfAborted()
      // Replace an incomplete previous installation only after the new package is ready.
      const destination = join(this.root, id)
      await rm(destination, { force: true, recursive: true })
      await rename(path, destination)
    } finally {
      await rm(path, { force: true, recursive: true }).catch(() => undefined)
    }
  }
}
