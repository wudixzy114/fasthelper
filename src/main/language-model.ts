import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:net'
import { availableParallelism } from 'node:os'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Intent } from '../shared/intent'
import type { SearchKind, SearchResult } from '../shared/contracts'
import { normalizeName } from '../shared/intent'
import type { LocalModelConfiguration } from './models'
import { maxDecisionCandidates, scoreCandidates, tokenizeAnswerSlots } from './semif'

type Endpoint = { url: string; key: string; child: ChildProcess; signal: AbortSignal; labelIds?: number[] }
type ModelPath = '/v1/chat/completions' | '/apply-template' | '/completion' | '/tokenize'

const systemPrompt = `判断用户是否明确请求打开应用或搜索文件。原样摘录最具体的应用名或文件关键词，省略客套、日期和修饰语。
只输出 JSON。kind 取 open_app、find_file 或 unknown，query 是从原文摘取的目标，unknown 时为空。否定句、闲聊、复合请求用 unknown。
示例：“我需要用一下记事本” → {"kind":"open_app","query":"记事本"}。“找一下上周开会用的预算表” → {"kind":"find_file","query":"预算表"}。`

const schema = {
  type: 'object',
  properties: {
    kind: { enum: ['open_app', 'find_file', 'unknown'] },
    query: { type: 'string' },
  },
  required: ['kind', 'query'],
  additionalProperties: false,
}

async function selectPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

export class LanguageModel {
  private endpoint?: Endpoint
  private starting?: Promise<Endpoint>
  private stopping?: Promise<void>
  private lifetime?: AbortController
  private idleTimer?: NodeJS.Timeout

  constructor(private readonly configuration: () => LocalModelConfiguration | null) {}

  async interpret(text: string, signal: AbortSignal): Promise<Intent | null> {
    const model = this.configuration()
    if (!model) return null
    const endpoint = await this.start(model)
    const body = await this.request(endpoint, '/v1/chat/completions', {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
      response_format: { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema } },
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 96,
      temperature: 0.15,
    }, this.budget(model, signal)) as { choices?: { message?: { content?: unknown } }[] }
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('本地模型没有返回有效结果。')
    const result = JSON.parse(content)
    const query = typeof result?.query === 'string' ? result.query.trim() : ''
    if (!query || !normalizeName(text).includes(normalizeName(query))) return null
    if (result.kind !== 'open_app' && result.kind !== 'find_file') return null
    const searchQuery = result.kind === 'find_file' && text.includes('上周') && !query.startsWith('上周')
      ? `上周的${query}` : query
    return { kind: result.kind, query: searchQuery, explicit: false }
  }

  async rank<T extends { title: string; detail: string; kind: SearchKind }>(
    text: string, candidates: readonly T[], signal: AbortSignal,
  ): Promise<{ results: (T & Pick<SearchResult, 'match'>)[]; uncertain: boolean } | null> {
    const model = this.configuration()
    if (!model || candidates.length < 2) return null
    const endpoint = await this.start(model)
    const budget = this.budget(model, signal)
    if (!endpoint.labelIds) {
      endpoint.labelIds = await tokenizeAnswerSlots((label) =>
        this.request(endpoint, '/tokenize', { content: label, add_special: false }, budget))
    }
    const shortlist = candidates.slice(0, maxDecisionCandidates)
    const decision = await scoreCandidates(
      (path, input) => this.request(endpoint, path, input, budget),
      endpoint.labelIds,
      text,
      shortlist.map(({ title, detail, kind }) => ({
        title, description: `${kind === 'app' ? '应用' : '文件'} · ${detail.slice(-54)}`,
      })),
    )
    if (!decision) return null
    const results = decision.order.map((index) => {
      const score = decision.scores[index]
      const match = score >= 0.65 && !decision.uncertain ? 'high' : score >= 0.25 ? 'medium' : 'low'
      return { ...shortlist[index], match } as T & Pick<SearchResult, 'match'>
    })
    return { results: [...results, ...candidates.slice(shortlist.length)], uncertain: decision.uncertain }
  }

  private budget(model: LocalModelConfiguration, signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(model.id === 'qwen35-4b' ? 30_000 : 12_000)])
  }

  private async request(endpoint: Endpoint, path: ModelPath, input: object, signal: AbortSignal): Promise<unknown> {
    const requestSignal = AbortSignal.any([signal, endpoint.signal])
    requestSignal.throwIfAborted()
    const response = await fetch(`${endpoint.url}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: requestSignal,
    })
    if (!response.ok) throw new Error(`本地模型请求失败 (${response.status})。`)
    return response.json()
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    clearTimeout(this.idleTimer)
    const endpoint = this.endpoint
    this.lifetime?.abort()
    const pending = this.starting
    this.stopping = (async () => {
      if (endpoint) await this.stopChild(endpoint.child)
      await pending?.catch(() => undefined)
      this.endpoint = undefined
      this.lifetime = undefined
    })().finally(() => { this.stopping = undefined })
    return this.stopping
  }

  private async start(model: LocalModelConfiguration): Promise<Endpoint> {
    await this.stopping
    if (this.configuration()?.id !== model.id) throw new Error('当前模型已切换。')
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.stop().catch(() => undefined), 180_000).unref()
    if (this.endpoint) return Promise.resolve(this.endpoint)
    if (this.starting) return this.starting
    this.lifetime = new AbortController()
    const signal = this.lifetime.signal
    this.starting = this.launch(model, signal).finally(() => { this.starting = undefined })
    return this.starting
  }

  private async launch(model: LocalModelConfiguration, signal: AbortSignal): Promise<Endpoint> {
    const port = await selectPort()
    signal.throwIfAborted()
    const key = randomBytes(24).toString('hex')
    const url = `http://127.0.0.1:${port}`
    const child = spawn(model.runtimePath, [
      '--model', model.weightsPath, '--host', '127.0.0.1', '--port', String(port),
      '--api-key', key, '--ctx-size', '1024', '--parallel', '1', '--n-gpu-layers', '0',
      '--threads', String(Math.min(6, availableParallelism())), '--reasoning', 'off', '--no-webui',
    ], {
      cwd: dirname(model.runtimePath), windowsHide: true, stdio: 'ignore',
      env: { ...process.env, LLAMA_OFFLINE: '1' },
    })
    let stopped = false
    child.once('error', () => { stopped = true })
    child.once('exit', () => {
      stopped = true
      if (this.endpoint?.child === child) this.endpoint = undefined
    })

    const ready = AbortSignal.any([signal, AbortSignal.timeout(model.id === 'qwen35-4b' ? 60_000 : 35_000)])
    try {
      while (!stopped) {
        ready.throwIfAborted()
        const health = await fetch(`${url}/health`, {
          redirect: 'error',
          signal: AbortSignal.any([ready, AbortSignal.timeout(800)]),
          headers: { Authorization: `Bearer ${key}` },
        }).catch(() => undefined)
        if (health?.ok) {
          ready.throwIfAborted()
          this.endpoint = { url, key, child, signal }
          return this.endpoint
        }
        await delay(200, undefined, { signal: ready })
      }
      throw new Error('本地推理引擎未能启动。')
    } catch (error) {
      await this.stopChild(child)
      throw error
    }
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.off('exit', exited)
        reject(new Error('本地推理引擎未退出。'))
      }, 3_000)
      function exited() {
        clearTimeout(timeout)
        resolve()
      }
      child.once('exit', exited)
      child.kill()
    })
  }
}
