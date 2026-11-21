import { createRequire } from 'node:module'
import { audioSampleRate } from '../shared/speech'
import type { SpeechConfiguration } from './speech-models'

export type SpeechRequest =
  | { type: 'begin'; id: string; config: SpeechConfiguration }
  | { type: 'chunk'; id: string; samples: Float32Array }
  | { type: 'finish' | 'cancel'; id: string }
export type SpeechReply =
  | { type: 'partial' | 'final'; id: string; text: string }
  | { type: 'ready' | 'ack' | 'error'; id: string }

type Sherpa = {
  createOnlineRecognizer(config: object): object
  createOnlineStream(recognizer: object): object
  acceptWaveformOnline(stream: object, waveform: { samples: Float32Array; sampleRate: number }): void
  inputFinished(stream: object): void
  isOnlineStreamReady(recognizer: object, stream: object): boolean
  decodeOnlineStream(recognizer: object, stream: object): void
  isEndpoint(recognizer: object, stream: object): boolean
  getOnlineStreamResultAsJson(recognizer: object, stream: object): string
}

const parent = process.parentPort
if (!parent) throw new Error('Missing voice process parent')
const nativeRequire = createRequire(__filename)
let runtime: { addon: Sherpa; recognizer: object; key: string } | undefined
let active: { id: string; stream: object; last: string } | undefined

function begin(id: string, config: SpeechConfiguration) {
  if (runtime?.key !== config.encoder) {
    const addon: Sherpa = nativeRequire(config.addon)
    const recognizer = addon.createOnlineRecognizer({
      featConfig: { sampleRate: audioSampleRate, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: config.encoder, decoder: config.decoder, joiner: config.joiner },
        tokens: config.tokens, numThreads: 2, provider: 'cpu', modelType: 'zipformer2',
      },
      enableEndpoint: true, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 0.85,
      rule3MinUtteranceLength: 60, decodingMethod: 'greedy_search',
    })
    runtime = { addon, recognizer, key: config.encoder }
  }
  active = { id, stream: runtime.addon.createOnlineStream(runtime.recognizer), last: '' }
}

parent.on('message', ({ data }: { data: SpeechRequest }) => {
  const report = (value: SpeechReply) => parent.postMessage(value)
  const { id } = data
  try {
    if (data.type === 'begin') {
      begin(id, data.config)
      report({ type: 'ready', id })
      return
    }
    if (!runtime || active?.id !== id) return
    const { addon, recognizer } = runtime
    const { stream } = active
    if (data.type === 'cancel') { active = undefined; return }
    const final = data.type === 'finish'
    const samples = data.type === 'chunk' ? data.samples : new Float32Array(audioSampleRate * 0.6)
    addon.acceptWaveformOnline(stream, { samples, sampleRate: audioSampleRate })
    if (final) addon.inputFinished(stream)
    while (addon.isOnlineStreamReady(recognizer, stream)) addon.decodeOnlineStream(recognizer, stream)
    const result = JSON.parse(addon.getOnlineStreamResultAsJson(recognizer, stream)) as { text?: string }
    const text = result.text?.trim() ?? ''
    if (final || (text && addon.isEndpoint(recognizer, stream))) {
      active = undefined
      report({ type: 'final', id, text })
    } else {
      if (text !== active.last) {
        active.last = text
        report({ type: 'partial', id, text })
      }
      report({ type: 'ack', id })
    }
  } catch {
    active = undefined
    report({ type: 'error', id })
  }
})
