class FasthelperCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(1600)
    this.used = 0
    this.running = true
    this.port.onmessage = ({ data }) => {
      if (data !== 'flush') return
      this.running = false
      if (this.used) this.send()
      this.port.postMessage('flushed')
    }
  }

  send() {
    const samples = this.samples.slice(0, this.used)
    this.port.postMessage(samples, [samples.buffer])
    this.used = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!this.running || !channel) return true
    for (const sample of channel) {
      this.samples[this.used++] = sample
      if (this.used === this.samples.length) this.send()
    }
    return true
  }
}

registerProcessor('fasthelper-capture', FasthelperCapture)
