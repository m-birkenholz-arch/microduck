import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SPEAKER_ENGINE } from './speaker-local.mjs';
export const MODEL_SHA256 = 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012';
export class SpeakerError extends Error {}
export function decodeSpeakerPcm(value) {
  if (!value || Object.keys(value).some(k => !['pcm', 'sampleRate'].includes(k)) || value.sampleRate !== 16000 ||
    typeof value.pcm !== 'string' || value.pcm.length > 512000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.pcm)) throw new SpeakerError('Ongeldige stemopname.');
  const bytes = Buffer.from(value.pcm, 'base64');
  if (bytes.length < 64000 || bytes.length > 384000 || bytes.length % 2 || bytes.toString('base64') !== value.pcm) throw new SpeakerError('Spreek twee tot twaalf seconden.');
  const pcm = new Int16Array(bytes.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  bytes.fill(0); return pcm;
}
export function createSpeakerBackend({ directory = path.dirname(fileURLToPath(import.meta.url)), makeWorker = (url, options) => new Worker(url, options) } = {}) {
  const model = path.join(directory, 'speaker-runtime', 'model.onnx'), runtime = path.join(directory, 'speaker-runtime', 'node_modules', 'sherpa-onnx-node');
  if (!existsSync(model) || !existsSync(path.join(runtime, 'package.json'))) return null;
  if (createHash('sha256').update(readFileSync(model)).digest('hex') !== MODEL_SHA256) return null;
  let worker, closed = false, healthy = true, busy = false, sequence = 0, pending, rejectReady;
  const ready = new Promise((resolve, reject) => {
    rejectReady = reject;
    worker = makeWorker(new URL('./speaker-worker.mjs', import.meta.url), { workerData: { model, runtime } });
    worker.on('message', data => {
      if (data.ready) resolve(true);
      else if (data.id && pending?.id === data.id) { data.error ? pending.reject(new SpeakerError(data.error)) : pending.resolve({ engine: SPEAKER_ENGINE, embedding: data.embedding }); pending = null; }
      else if (data.error && !data.id) { healthy = false; reject(new SpeakerError(data.error)); void worker.terminate(); }
    });
    const fail = () => { healthy = false; reject(new SpeakerError('Lokale stemherkenning is gestopt. Start de gesprekshulp opnieuw.')); pending?.reject(new SpeakerError('Stemherkenning gestopt.')); pending = null; };
    worker.on('error', fail); worker.on('exit', fail);
  });
  const startupTimer = setTimeout(() => { healthy = false; rejectReady(new SpeakerError('Stemmodel starten duurde te lang.')); void worker?.terminate(); }, 4000);
  ready.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
  return {
    async available() { try { return !closed && healthy && await ready && healthy; } catch { return false; } },
    async embed(value, signal) {
      if (busy) throw new SpeakerError('Er loopt al een stemanalyse. Probeer zo opnieuw.');
      const pcm = decodeSpeakerPcm(value); busy = true;
      try {
        if (!await this.available()) throw new SpeakerError('Stemherkenning is niet beschikbaar. Installeer met -SpeakerRecognition.');
        signal.throwIfAborted(); const id = ++sequence;
        const inference = new Promise((resolve, reject) => { pending = { id, resolve, reject }; worker.postMessage({ id, pcm }, [pcm.buffer]); });
        // Native inference is short and isolated from HTTP/WebRTC; keep the slot
        // until it finishes even when the caller disconnects, avoiding a queue.
        const result = await inference; signal.throwIfAborted(); return result;
      } finally { busy = false; if (pcm.byteLength) pcm.fill(0); }
    },
    close() { closed = true; rejectReady?.(new SpeakerError('Gestopt.')); pending?.reject(new SpeakerError('Gestopt.')); pending = null; void worker?.terminate(); },
  };
}
