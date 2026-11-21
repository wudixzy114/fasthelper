import { onMounted, onUnmounted, ref } from 'vue'
import { audioSampleRate } from '../../shared/speech'
import worklet from './speech-worklet.js?url&no-inline'

export function useSpeech(onText: (text: string) => void, onError: (message: string) => void, onSubmit: () => void) {
  const api = window.fasthelper
  const state = ref<'idle' | 'starting' | 'recording' | 'finishing'>('idle')
  let revision = 0
  let recording: string | undefined
  let audio: AudioContext | undefined
  let stream: MediaStream | undefined
  let node: AudioWorkletNode | undefined
  let flushed: (() => void) | undefined
  let submitAfter = false
  let unsubscribe: (() => void) | undefined

  function release() {
    node?.disconnect()
    if (node) node.port.onmessage = null
    node = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    if (audio) void audio.close().catch(() => undefined)
    audio = undefined
    flushed?.()
    flushed = undefined
  }

  function cancel() {
    revision += 1
    submitAfter = false
    if (recording) void api.cancelSpeech(recording).catch(() => undefined)
    recording = undefined
    release()
    state.value = 'idle'
  }

  onMounted(() => {
    unsubscribe = api.onSpeech((event) => {
      if (event.id !== recording) return
      if (event.type === 'partial') { onText(event.text); return }
      const submit = submitAfter
      cancel()
      if (event.type === 'error') onError(event.message)
      else {
        onText(event.text)
        if (event.text.trim() && submit) onSubmit()
        else if (!event.text.trim()) onError('没有识别到语音，可以重试。')
      }
    })
  })
  onUnmounted(() => { unsubscribe?.(); cancel() })

  async function begin() {
    if (state.value !== 'idle') return
    const request = ++revision
    state.value = 'starting'
    try {
      const id = await api.beginSpeech()
      if (request !== revision) { void api.cancelSpeech(id).catch(() => undefined); return }
      recording = id
      const source = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })
      if (request !== revision) { source.getTracks().forEach((track) => track.stop()); return }
      stream = source
      audio = new AudioContext({ sampleRate: audioSampleRate })
      await audio.audioWorklet.addModule(worklet)
      if (request !== revision) return
      node = new AudioWorkletNode(audio, 'fasthelper-capture')
      node.port.onmessage = ({ data }) => {
        if (request !== revision || !recording) return
        if (data === 'flushed') flushed?.()
        else if (data instanceof Float32Array) api.pushSpeech(recording, data)
      }
      const silent = audio.createGain()
      silent.gain.value = 0
      audio.createMediaStreamSource(source).connect(node).connect(silent).connect(audio.destination)
      await audio.resume()
      if (request === revision) state.value = 'recording'
    } catch (error) {
      if (request !== revision) return
      cancel()
      onError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '无法使用麦克风。请检查 Windows 的麦克风权限。' : '无法开始录音。请检查麦克风和本地语音设置。')
    }
  }

  async function finish(submit = false) {
    if (state.value === 'finishing') { submitAfter ||= submit; return }
    if (state.value !== 'recording' || !recording) return
    const id = recording
    state.value = 'finishing'
    submitAfter = submit
    try {
      if (node) await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 160)
        flushed = () => { clearTimeout(timeout); resolve() }
        node?.port.postMessage('flush')
      })
      if (recording !== id) return
      release()
      await api.finishSpeech(id)
    } catch {
      if (recording !== id) return
      cancel()
      onError('语音未能完成转写，请重试。')
    }
  }

  return { state, begin, finish, cancel }
}
