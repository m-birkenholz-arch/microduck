export async function createDuckVoice(context, semitones = 5) {
  if (!context.audioWorklet) throw new Error('Eendenstem vereist Chrome of Edge op http://localhost:5173.');
  await context.audioWorklet.addModule(new URL('./voice-worklet.mjs', import.meta.url));
  const input = new AudioWorkletNode(context, 'duck-voice', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit', processorOptions: { semitones },
  });
  const output = context.createGain();
  output.gain.value = 0;
  input.connect(output);
  return {
    input, output,
    setPitch(value) { input.port.postMessage({ type: 'pitch', value }); },
    setMuted(muted) {
      output.gain.cancelScheduledValues(context.currentTime);
      output.gain.setValueAtTime(muted ? 0 : 1, context.currentTime);
      if (muted) input.port.postMessage({ type: 'reset' });
    },
    close() { input.onprocessorerror = null; input.disconnect(); input.port.close(); output.disconnect(); },
  };
}
