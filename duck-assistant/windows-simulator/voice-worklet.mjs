// Two crossfaded variable-delay read heads raise pitch and formants together.
// Output keeps the input's duration: no accumulated playback backlog or speedup.
export class DuckPitchShifter {
  constructor(rate, semitones = 5) {
    this.span = Math.round(rate * 0.060);
    this.minimum = Math.round(rate * 0.008);
    this.buffer = new Float32Array(this.span + this.minimum + 4);
    this.setPitch(semitones);
    this.reset();
  }
  setPitch(value) {
    this.semitones = Number.isFinite(value) ? Math.max(0, Math.min(9, value)) : 5;
    this.ratio = 2 ** (this.semitones / 12);
  }
  reset() { this.buffer.fill(0); this.write = 0; this.phase = 0; }
  read(delay) {
    let position = (this.write - delay + this.buffer.length) % this.buffer.length;
    const index = Math.floor(position);
    const fraction = position - index;
    return this.buffer[index] * (1 - fraction) + this.buffer[(index + 1) % this.buffer.length] * fraction;
  }
  process(input, output) {
    for (let i = 0; i < output.length; i++) {
      const sample = input?.[i] || 0;
      this.buffer[this.write] = sample;
      if (this.semitones === 0) output[i] = sample;
      else {
        const other = (this.phase + 0.5) % 1;
        const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase);
        output[i] = weight * this.read(this.minimum + this.span * (1 - this.phase))
          + (1 - weight) * this.read(this.minimum + this.span * (1 - other));
      }
      this.write = (this.write + 1) % this.buffer.length;
      this.phase = (this.phase + (this.ratio - 1) / this.span) % 1;
    }
  }
}

if (typeof registerProcessor === 'function') {
  class DuckVoiceProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.shifter = new DuckPitchShifter(sampleRate, options.processorOptions?.semitones);
      this.port.onmessage = ({ data }) => {
        if (data.type === 'reset') this.shifter.reset();
        if (data.type === 'pitch') this.shifter.setPitch(data.value);
      };
    }
    process(inputs, outputs) {
      this.shifter.process(inputs[0]?.[0], outputs[0][0]);
      return true;
    }
  }
  registerProcessor('duck-voice', DuckVoiceProcessor);
}
