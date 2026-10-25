import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
try {
  const sherpa = require(workerData.runtime);
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: workerData.model, numThreads: 2, provider: 'cpu', debug: false });
  if (extractor.dim !== 256) throw Error('model dimension');
  parentPort.postMessage({ ready: true });
  parentPort.on('message', ({ id, pcm }) => {
    try {
      const samples = new Float32Array(pcm.length); let voiced = 0;
      for (let n = 0; n < pcm.length; n++) samples[n] = pcm[n] / 32768;
      for (let n = 0; n + 320 <= samples.length; n += 320) {
        let energy = 0; for (let i = n; i < n + 320; i++) energy += samples[i] ** 2;
        if (Math.sqrt(energy / 320) >= 0.012) voiced += 320;
      }
      if (voiced < 16000 * 1.5) throw Error('Spreek iets langer en duidelijker, met weinig achtergrondgeluid.');
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 }); stream.inputFinished();
      if (!extractor.isReady(stream)) throw Error('Te weinig spraak voor een stemprofiel.');
      const embedding = Array.from(extractor.compute(stream, false)); samples.fill(0); pcm.fill(0);
      parentPort.postMessage({ id, embedding });
    } catch (error) { pcm.fill(0); parentPort.postMessage({ id, error: error.message || 'Stem kon niet worden geanalyseerd.' }); }
  });
} catch { parentPort.postMessage({ error: 'Lokaal stemmodel kon niet laden. Installeer opnieuw met -SpeakerRecognition.' }); }
