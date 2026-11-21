import type { ModelState } from './contracts'

export const speechOptions = [
  { id: 'xasr-zh-en-480ms', name: 'X-ASR-zh-en', size: '0.16B', bytes: 623659260,
    description: '普通话与英语混合识别 · 流式 CPU 推理',
    source: 'https://huggingface.co/GilgameshWind/X-ASR-zh-en' },
] as const

export type SpeechModelId = (typeof speechOptions)[number]['id']
export type SpeechSettings = { models: Record<SpeechModelId, ModelState>; active: SpeechModelId | null }
export type SpeechEvent =
  | { id: string; type: 'partial' | 'final'; text: string }
  | { id: string; type: 'error'; message: string }

export const audioSampleRate = 16_000
export const audioChunkSize = 1600
export const maxRecordingSamples = audioSampleRate * 60
