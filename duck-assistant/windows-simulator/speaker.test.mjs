import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { SpeakerGallery, LocalSpeaker, SpeakerRing, normalizedVoice, encodeSpeakerPcm, SPEAKER_ENGINE, SPEAKER_STORAGE_KEY } from './speaker-local.mjs';
import { SpeakerPcm } from './speaker-worklet.mjs';
import { recordSpeakerSample, waitRecording } from './speaker-panel.mjs';
import { decodeSpeakerPcm, SpeakerError } from './speaker-backend.mjs';
import { createConversationServer } from './server.mjs';
const vector = (n = 0) => Array.from({ length: 256 }, (_, i) => i === n ? 1 : 0);
const storage = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v), data }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const pcm = () => new Int16Array(16000 * 3).fill(6000);

test('speaker profiles store only three numerical embeddings and a name, reload, remove and stay separate from face and companion data', () => {
  const data = storage(), gallery = new SpeakerGallery(data, () => 'one');
  gallery.add('Michael', [vector(), vector(), vector()]);
  const saved = JSON.parse(data.getItem(SPEAKER_STORAGE_KEY));
  assert.deepEqual(Object.keys(saved.profiles[0]), ['id', 'name', 'samples']); assert.equal(saved.engine, SPEAKER_ENGINE);
  assert.equal(data.data.size, 1); assert.equal(saved.profiles[0].samples[0].length, 256);
  assert.equal(new SpeakerGallery(data).match(vector()).name, 'Michael');
  gallery.remove('one'); assert.equal(new SpeakerGallery(data).profiles.length, 0);
});

test('invalid, unknown, ambiguous, inconsistent and duplicate voices never become a new identity', () => {
  const gallery = new SpeakerGallery(storage(), () => 'one');
  assert.equal(normalizedVoice(new Array(256).fill(0)), null); assert.equal(normalizedVoice([1]), null);
  const bad = vector(); bad[3] = NaN; assert.equal(normalizedVoice(bad), null);
  assert.throws(() => gallery.add('A', [vector(), vector(1), vector()]), /verschillen/);
  gallery.add('A', [vector(), vector(), vector()]);
  assert.equal(gallery.match(vector(1)), null);
  assert.throws(() => gallery.add('B', [vector(), vector(), vector()]), /bestaand/);
  gallery.profiles.push({ id: 'other', name: 'B', samples: [vector(), vector(), vector()] });
  assert.equal(gallery.match(vector()), null);
});

test('profile storage failures cannot claim successful enrollment and incompatible saved models are ignored', () => {
  const gallery = new SpeakerGallery({ getItem: () => null, setItem() { throw Error(); } });
  assert.throws(() => gallery.add('M', [vector(), vector(), vector()]), /bewaren/); assert.equal(gallery.profiles.length, 0);
  const data = storage(); data.setItem(SPEAKER_STORAGE_KEY, '{broken'); assert.ok(new SpeakerGallery(data).error);
  data.setItem(SPEAKER_STORAGE_KEY, JSON.stringify({ engine: 'other', profiles: [{ id: 'one', name: 'M', samples: [vector(), vector(), vector()] }] }));
  assert.equal(new SpeakerGallery(data).profiles.length, 0);
});

test('local PCM ring is bounded to twelve seconds, clears audio and encodes explicit little-endian samples', () => {
  const ring = new SpeakerRing(); ring.push(new Int16Array(200000).fill(7));
  assert.equal(ring.take().length, 192000); assert.equal(ring.take().at(-1), 7);
  ring.clear(); assert.equal(ring.total, 0); assert.ok(ring.buffer.every(v => v === 0));
  const samples = pcm(); samples[0] = -32768; samples[1] = 32767;
  const decoded = decodeSpeakerPcm({ sampleRate: 16000, pcm: encodeSpeakerPcm(samples) });
  assert.equal(decoded[0], -32768); assert.equal(decoded[1], 32767);
  for (const value of [{ pcm: 'url', sampleRate: 16000 }, { pcm: encodeSpeakerPcm(samples), sampleRate: 48000 }, { pcm: 'AAAA', sampleRate: 16000 }, { pcm: encodeSpeakerPcm(samples), sampleRate: 16000, extra: 1 }]) {
    assert.throws(() => decodeSpeakerPcm(value), SpeakerError);
  }
});

test('microphone conversion emits 16 kHz PCM at common browser rates and clamps invalid input', () => {
  for (const rate of [44100, 48000]) {
    const chunks = [], converter = new SpeakerPcm(rate, chunk => chunks.push(chunk));
    converter.process(new Float32Array(rate).fill(0.5));
    assert.equal(chunks.length, 10); assert.equal(chunks.reduce((n, c) => n + c.length, 0), 16000);
    assert.ok(chunks.every(chunk => chunk.every(v => v === 16384)));
  }
  const chunks = [], converter = new SpeakerPcm(16000, chunk => chunks.push(chunk));
  converter.process(new Float32Array(1600).fill(Infinity)); assert.ok(chunks[0].every(v => v === 0));
});

function fixture(fetchImpl = async () => Response.json({ engine: SPEAKER_ENGINE, embedding: vector() })) {
  let callback, closed = 0, clock = 1000;
  const states = [], gallery = new SpeakerGallery(storage(), () => 'one'); gallery.add('Michael', [vector(), vector(), vector()]);
  const speaker = new LocalSpeaker({ gallery, fetchImpl, now: () => clock, onState: message => states.push(message),
    makeTap: async (context, stream, onChunk) => { callback = onChunk; return { close() { closed++; } }; } });
  return { speaker, states, chunk: value => callback(value), closed: () => closed, advance: n => { clock += n; } };
}

test('opt-in speech recognition uses only input speech, withholds short or stale turns and sends no name or profile to the embedding endpoint', async () => {
  let requests = 0;
  const f = fixture(async (url, init) => {
    requests++; assert.equal(url, 'http://127.0.0.1:8787/speaker/embed');
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['pcm', 'sampleRate']);
    assert.ok(!init.body.includes('Michael')); return Response.json({ engine: SPEAKER_ENGINE, embedding: vector() });
  });
  await f.speaker.attach({}, {}); assert.equal(f.speaker.tap, null); assert.equal(requests, 0);
  f.speaker.setEnabled(true); await f.speaker.attach({}, {});
  f.speaker.speech(true); f.chunk(new Int16Array(8000)); f.speaker.speech(false);
  assert.equal((await f.speaker.status()).possible_speaker_name, null); assert.equal(requests, 0);
  f.speaker.speech(true); f.chunk(pcm()); f.speaker.speech(false);
  assert.equal((await f.speaker.status()).possible_speaker_name, 'Michael'); assert.equal(requests, 1);
  f.advance(16000); assert.equal((await f.speaker.status()).possible_speaker_name, null);
  f.speaker.speech(true); assert.equal((await f.speaker.status()).possible_speaker_name, null);
  f.speaker.setEnabled(false); assert.equal(f.closed(), 1); assert.equal(f.speaker.ring.total, 0);
});

test('disabling recognition or beginning a new turn cancels old work and prevents late names', async () => {
  for (const disable of [false, true]) {
    let release, signal;
    const f = fixture(async (url, init) => { signal = init.signal; return new Promise(resolve => { release = () => resolve(Response.json({ engine: SPEAKER_ENGINE, embedding: vector() })); }); });
    f.speaker.setEnabled(true); await f.speaker.attach({}, {}); f.speaker.speech(true); f.chunk(pcm()); f.speaker.speech(false);
    const pending = f.speaker.status();
    if (disable) f.speaker.setEnabled(false); else f.speaker.speech(true);
    assert.equal(signal.aborted, true); release();
    assert.equal((await pending).possible_speaker_name, null); assert.equal((await f.speaker.status()).possible_speaker_name, null);
    f.speaker.setEnabled(false);
  }
});

test('a late microphone tap after Stop is released and cannot collect audio', async () => {
  let resolve, onChunk, closed = 0;
  const speaker = new LocalSpeaker({ gallery: new SpeakerGallery(storage()), makeTap: async (context, stream, callback) => { onChunk = callback; return new Promise(r => { resolve = r; }); } });
  speaker.setEnabled(true); const attach = speaker.attach({}, {}); speaker.setEnabled(false);
  resolve({ close: () => closed++ }); await attach; onChunk(pcm());
  assert.equal(closed, 1); assert.equal(speaker.ring.total, 0); assert.equal(speaker.tap, null);
});

test('enrollment microphone releases tracks and context on success, cancellation and late permission results', async () => {
  let stopped = 0, closed = 0;
  const options = { mediaDevices: { getUserMedia: async opts => { assert.ok(opts.audio.echoCancellation); return { getTracks: () => [{ stop: () => stopped++ }] }; } },
    makeContext: () => ({ resume: async () => {}, close: async () => { closed++; } }),
    makeTap: async (context, stream, onChunk) => { onChunk(pcm()); return { close() {} }; }, wait: async () => {} };
  const samples = await recordSpeakerSample(new AbortController().signal, options);
  assert.equal(samples.length, 48000); assert.equal(stopped, 1); assert.equal(closed, 1);
  let release; const controller = new AbortController();
  const pending = recordSpeakerSample(controller.signal, { ...options, mediaDevices: { getUserMedia: () => new Promise(resolve => { release = resolve; }) } });
  controller.abort(); release({ getTracks: () => [{ stop: () => stopped++ }] });
  await assert.rejects(pending); assert.equal(stopped, 2);
  const cancelled = new AbortController(); const waiting = waitRecording(10000, cancelled.signal); cancelled.abort(); await assert.rejects(waiting, /gestopt/);
});

test('speaker HTTP endpoint has host/origin, type and payload protections, stays local and reports readiness', async t => {
  let calls = 0, closed = 0;
  const backend = { available: async () => true, close: () => closed++, embed: async (value, signal) => { calls++; decodeSpeakerPcm(value); signal.throwIfAborted(); return { engine: SPEAKER_ENGINE, embedding: vector() }; } };
  const app = createConversationServer({ apiKey: 'secret', speakerBackend: backend, fetchImpl: async () => { throw Error('Must not call cloud'); } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.close(); app.closeAllConnections(); });
  const url = `http://127.0.0.1:${app.address().port}`;
  const request = (body, headers = {}) => fetch(url + '/speaker/embed', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const health = await (await fetch(url + '/health', { headers: { Origin: 'http://localhost:5173' } })).json(); assert.equal(health.speakerRecognition, true);
  const value = { sampleRate: 16000, pcm: encodeSpeakerPcm(pcm()) };
  assert.equal((await request(value, { Origin: 'https://evil.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { const req = httpRequest(url + '/speaker/embed', { method: 'POST', headers: { Host: 'evil.example', Origin: 'http://localhost:5173' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await request(value, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request({ pcm: 'a'.repeat(520000) })).status, 413); assert.equal(calls, 0);
  const response = await request(value); assert.equal(response.status, 200); assert.equal((await response.json()).embedding.length, 256); assert.equal(calls, 1);
  assert.equal((await request({ pcm: 'url', sampleRate: 16000 })).status, 400);
  app.close(); app.closeAllConnections(); await once(app, 'close'); assert.equal(closed, 1);
});
