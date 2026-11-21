import { randomUUID } from 'node:crypto'
import type { ConversationResponse, PluginCapability } from '../shared/conversation.ts'

export type RouteOption = { id: string; title: string; capability: PluginCapability }
type RouteScores = { scores: readonly number[]; abstentionScore: number }
type Handler = RouteOption & {
  run(session: number, text: string, stage: 'preview' | 'submit'): Promise<ConversationResponse>
}
type Pending = {
  controller: AbortController
  text: string
  choices: Map<string, string>
}

const empty: ConversationResponse = { kind: 'empty' }

export function routeDecision(scores: RouteScores, count: number): { direct?: number; candidates: number[] } {
  if (scores.scores.length !== count || ![scores.abstentionScore, ...scores.scores].every((p) => Number.isFinite(p) && p >= 0 && p <= 1)) {
    return { candidates: [] }
  }
  const ordered = scores.scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score)
  const [top, second] = ordered
  if (!top || top.score <= scores.abstentionScore) return { candidates: [] }
  const gap = top.score - Math.max(second?.score ?? 0, scores.abstentionScore)
  if (top.score >= 0.80 && gap >= 0.20) return { direct: top.index, candidates: [] }
  return { candidates: ordered.slice(0, 3).map(({ index }) => index) }
}

export class ConversationService {
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly handlers: () => readonly Handler[],
    private readonly score: (text: string, options: readonly RouteOption[], signal: AbortSignal) => Promise<RouteScores | null>,
    private readonly cancelPlugin: (session?: number) => void,
  ) {}

  clear(session?: number) {
    if (session === undefined) {
      for (const pending of this.pending.values()) pending.controller.abort()
      this.pending.clear()
    } else {
      this.pending.get(session)?.controller.abort()
      this.pending.delete(session)
    }
    this.cancelPlugin(session)
  }

  async input(session: number, raw: string, stage: 'preview' | 'submit'): Promise<ConversationResponse> {
    this.clear(session)
    const text = raw.trim()
    if (!text) return empty
    const pending: Pending = { controller: new AbortController(), text, choices: new Map() }
    this.pending.set(session, pending)
    const { signal } = pending.controller
    const options = this.handlers()
    const preview = stage === 'preview'
    if (!options.length) return preview ? empty : { kind: 'notice', message: '请先在功能管理中启用一个插件。' }
    if (preview && !options.some(({ capability }) => capability.preview)) return empty
    try {
      if (preview && options.length === 1) return this.run(session, pending, options[0].id, stage)
      const scores = await this.score(text, options, signal).catch(() => null)
      if (signal.aborted) return empty
      if (scores) {
        const decision = routeDecision(scores, options.length)
        if (decision.direct !== undefined) return this.run(session, pending, options[decision.direct].id, stage)
        if (preview) return empty
        if (!decision.candidates.length) return { kind: 'notice', message: '没有找到适合这条指令的插件。可以补充目标或改写指令。' }
        return this.choices(pending, decision.candidates.map((index) => options[index]), '请选择要执行这条指令的插件。')
      }
      return preview ? empty : this.choices(pending, options.slice(0, 3), '本地决策暂不可用，请选择插件。')
    } catch {
      return signal.aborted ? empty : { kind: 'notice', message: '指令处理失败，请重试。' }
    }
  }

  async choose(session: number, token: string): Promise<ConversationResponse> {
    const pending = this.pending.get(session)
    const id = pending?.choices.get(token)
    if (!pending || !id) return { kind: 'notice', message: '这组候选已失效，请重新提交指令。' }
    pending.choices.clear()
    return this.run(session, pending, id, 'submit')
  }

  private choices(pending: Pending, options: readonly RouteOption[], message: string): ConversationResponse {
    return {
      kind: 'choices', message,
      choices: options.map((option) => {
        const token = randomUUID()
        pending.choices.set(token, option.id)
        return { token, title: option.title, description: option.capability.description }
      }),
    }
  }

  private async run(session: number, pending: Pending, id: string, stage: 'preview' | 'submit'): Promise<ConversationResponse> {
    const { signal } = pending.controller
    if (signal.aborted) return empty
    const option = this.handlers().find((entry) => entry.id === id)
    if (stage === 'preview' && !option?.capability.preview) return empty
    if (!option) return { kind: 'notice', message: '插件当前不可用，请重新提交指令。' }
    try {
      const result = await option.run(session, pending.text, stage)
      return signal.aborted ? empty : result
    } catch {
      return signal.aborted ? empty : { kind: 'notice', message: '插件未能完成请求，请重试。' }
    }
  }
}
