// A short-lived local 16 kHz stream; output is silence, never microphone monitoring.
export class SpeakerPcm {
  constructor(rate, emit) { this.rate = rate; this.emit = emit; this.phase = 0; this.sum = 0; this.count = 0; this.chunk = new Int16Array(1600); this.used = 0; }
  process(input) {
    for (const value of input) {
      this.sum += Number.isFinite(value) ? value : 0; this.count++; this.phase += 16000;
      if (this.phase >= this.rate) {
        this.phase -= this.rate;
        this.chunk[this.used++] = Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 32767);
        this.sum = this.count = 0;
        if (this.used === this.chunk.length) { this.emit(this.chunk); this.chunk = new Int16Array(1600); this.used = 0; }
      }
    }
  }
}
if (typeof registerProcessor === 'function') registerProcessor('duck-speaker-pcm', class extends AudioWorkletProcessor {
  constructor() { super(); this.pcm = new SpeakerPcm(sampleRate, chunk => this.port.postMessage(chunk, [chunk.buffer])); }
  process(inputs, outputs) {
    if (inputs[0]?.[0]) this.pcm.process(inputs[0][0]);
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
});
