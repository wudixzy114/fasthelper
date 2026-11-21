import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { audioChunkSize, maxRecordingSamples, type SpeechEvent } from '../shared/speech'
import type { SpeechRequest, SpeechReply } from './speech-worker'
import type { SpeechConfiguration } from './speech-models'

type Recording = {
  id: string
  owner: number
  sent: number
  queued: number
  ready: boolean
  finishing: boolean
  timeout: NodeJS.Timeout
}

export class SpeechEngine {
  private worker?: UtilityProcess
  private recording?: Recording
  private idle?: NodeJS.Timeout
  private stopping?: Promise<void>

  constructor(
    private readonly configuration: () => SpeechConfiguration | null,
    private readonly notify: (owner: number, event: SpeechEvent) => void,
  ) {}

  allowed(owner: number) {
    return this.recording?.owner === owner && !this.recording.finishing
  }

  async begin(owner: number): Promise<string> {
    await this.stopping
    if (this.recording) throw new Error('已有语音输入正在进行。')
    const config = this.configuration()
    if (!config) throw new Error('请先在本地模型中启用语音识别。')
    clearTimeout(this.idle)
    this.worker ??= this.startWorker(config)
    const id = randomUUID()
    const timeout = setTimeout(() => this.fail('语音输入超时，请重试。'), 75_000).unref()
    this.recording = { id, owner, sent: 0, queued: 0, ready: false, finishing: false, timeout }
    this.send({ type: 'begin', id, config })
    return id
  }

  push(owner: number, id: string, samples: unknown) {
    const recording = this.recording
    if (!recording || recording.owner !== owner || recording.id !== id || recording.finishing) return
    if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length > audioChunkSize) return
    if (recording.queued >= (recording.ready ? 24 : 100)) {
      this.fail('语音处理跟不上录音速度，请重试。')
      return
    }
    recording.sent += samples.length
    recording.queued += 1
    this.send({ type: 'chunk', id, samples })
    if (recording.sent >= maxRecordingSamples) this.finish(owner, id)
  }

  finish(owner: number, id: string) {
    const recording = this.recording
    if (recording?.owner !== owner || recording.id !== id || recording.finishing) return
    recording.finishing = true
    this.send({ type: 'finish', id })
  }

  cancel(owner: number, id?: string) {
    const recording = this.recording
    if (recording?.owner !== owner || (id !== undefined && recording.id !== id)) return
    this.send({ type: 'cancel', id: recording.id })
    this.complete()
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const recording = this.recording
    this.complete()
    if (recording) this.notify(recording.owner, { type: 'error', id: recording.id, message: '本地语音输入已停止。' })
    clearTimeout(this.idle)
    const worker = this.worker
    this.worker = undefined
    if (!worker) return Promise.resolve()
    this.stopping = new Promise<void>((resolve, reject) => {
      if (!worker.pid) { worker.kill(); resolve(); return }
      const timer = setTimeout(() => {
        worker.off('exit', exited)
        reject(new Error('语音运行时未退出。'))
      }, 4000)
      function exited() { clearTimeout(timer); resolve() }
      worker.once('exit', exited)
      worker.kill()
    }).finally(() => { this.stopping = undefined })
    return this.stopping
  }

  private startWorker(config: SpeechConfiguration) {
    const worker = utilityProcess.fork(join(__dirname, 'speech-worker.js'), [], {
      serviceName: 'fasthelper speech', stdio: 'ignore',
      env: { ...process.env, PATH: dirname(config.addon) + ';' + (process.env.PATH ?? '') },
    })
    worker.on('message', (reply: SpeechReply) => {
      const recording = this.recording
      if (this.worker !== worker || !recording || recording.id !== reply.id) return
      switch (reply.type) {
        case 'ready': recording.ready = true; break
        case 'ack': recording.queued = Math.max(0, recording.queued - 1); break
        case 'partial': this.notify(recording.owner, reply); break
        case 'final': this.complete(); this.notify(recording.owner, reply); break
        case 'error': this.fail('本地语音识别失败，请检查模型安装后重试。'); break
      }
    })
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = undefined
        this.fail('本地语音运行时已退出，请重试。')
      }
    })
    return worker
  }

  private send(message: SpeechRequest) { this.worker?.postMessage(message) }

  private complete() {
    if (this.recording) clearTimeout(this.recording.timeout)
    this.recording = undefined
    clearTimeout(this.idle)
    if (this.worker) this.idle = setTimeout(() => void this.stop().catch(() => undefined), 60_000).unref()
  }

  private fail(message: string) {
    const recording = this.recording
    if (!recording) return
    this.cancel(recording.owner)
    this.notify(recording.owner, { type: 'error', id: recording.id, message })
  }
}
