export const SPEAKER_ENGINE = 'wespeaker-en-v1';
export const SPEAKER_STORAGE_KEY = 'microduck.speakers.v1';
export const speakerStatusTool = { type: 'function', name: 'get_speaker_status',
  description: 'Lees de mogelijke spreker van de laatste gesproken beurt uit lokale stemherkenning. Wacht zo nodig op de lokale analyse. Alleen bij ingeschakelde stemherkenning en naamdeling. Geen audio of stemprofielen beschikbaar; een mogelijke naam is geen identiteitsbewijs.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } };
export function normalizedVoice(value) {
  if (!value || value.length !== 256 || !Array.from(value).every(v => Number.isFinite(v) && Math.abs(v) <= 10)) return null;
  const norm = Math.hypot(...value);
  return norm > 0.1 ? Array.from(value, v => v / norm) : null;
}
export const voiceSimilarity = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
export class SpeakerGallery {
  constructor(storage, makeId = () => globalThis.crypto.randomUUID()) {
    this.storage = storage; this.makeId = makeId; this.profiles = []; this.error = '';
    try {
      const saved = JSON.parse(storage?.getItem(SPEAKER_STORAGE_KEY) || 'null');
      if (saved?.engine === SPEAKER_ENGINE && Array.isArray(saved.profiles)) this.profiles = saved.profiles.filter(p =>
        typeof p?.id === 'string' && p.id.length <= 80 && typeof p.name === 'string' && p.name.trim() && p.name.length <= 60 &&
        p.samples?.length === 3 && p.samples.every(normalizedVoice)).slice(0, 5)
        .map(p => ({ id: p.id, name: p.name.trim(), samples: p.samples.map(normalizedVoice) }));
    } catch { this.error = 'Stemprofielen konden niet worden gelezen.'; }
  }
  write(profiles) {
    try { if (!this.storage) throw Error(); this.storage.setItem(SPEAKER_STORAGE_KEY, JSON.stringify({ engine: SPEAKER_ENGINE, profiles })); }
    catch { throw Error('Stemprofiel bewaren lukt niet. Controleer browseropslag.'); }
    this.profiles = profiles;
  }
  add(name, samples) {
    name = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
    if (!name || name.length > 60) throw Error('Vul je naam in (maximaal 60 tekens).');
    if (this.profiles.length >= 5) throw Error('Verwijder eerst een van de vijf stemprofielen.');
    if (this.profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) throw Error('Deze naam is al aangeleerd. Verwijder eerst het oude stemprofiel.');
    if (!Array.isArray(samples) || samples.length !== 3 || !samples.every(normalizedVoice)) throw Error('Drie geldige stemopnames nodig.');
    samples = samples.map(normalizedVoice);
    if (samples.some(a => samples.some(b => voiceSimilarity(a, b) < 0.80))) throw Error('De opnames verschillen te veel. Spreek alleen en probeer opnieuw.');
    if (samples.some(v => this.match(v))) throw Error('Deze stem lijkt op een bestaand profiel. Verwijder dat eerst als je opnieuw wilt aanleren.');
    const profile = { id: this.makeId(), name, samples }; this.write([...this.profiles, profile]); return profile;
  }
  remove(id) { this.write(this.profiles.filter(p => p.id !== id)); }
  clear() { this.write([]); }
  match(value) {
    const v = normalizedVoice(value); if (!v) return null;
    const ranked = this.profiles.map(p => ({ id: p.id, name: p.name,
      score: p.samples.reduce((sum, sample) => sum + voiceSimilarity(sample, v), 0) / 3 })).sort((a, b) => b.score - a.score);
    return ranked[0]?.score >= 0.82 && (!ranked[1] || ranked[0].score - ranked[1].score >= 0.10) ? ranked[0] : null;
  }
}

export class SpeakerRing {
  constructor() { this.buffer = new Int16Array(16000 * 12); this.total = 0; }
  push(chunk) { for (const sample of chunk) this.buffer[this.total++ % this.buffer.length] = sample; }
  take(start = Math.max(0, this.total - this.buffer.length)) {
    start = Math.max(start, this.total - this.buffer.length, 0);
    return Int16Array.from({ length: this.total - start }, (_, n) => this.buffer[(start + n) % this.buffer.length]);
  }
  clear() { this.buffer.fill(0); this.total = 0; }
}
export function encodeSpeakerPcm(samples) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  samples.forEach((v, i) => view.setInt16(i * 2, v, true));
  let binary = ''; for (let n = 0; n < bytes.length; n += 8192) binary += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return btoa(binary);
}
export async function createSpeakerTap(context, stream, onChunk) {
  await context.audioWorklet.addModule(new URL('./speaker-worklet.mjs', import.meta.url));
  const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'duck-speaker-pcm');
  node.port.onmessage = event => { if (event.data instanceof Int16Array) onChunk(event.data); };
  source.connect(node); node.connect(context.destination);
  return { close() { node.port.onmessage = null; node.port.close(); source.disconnect(); node.disconnect(); } };
}
export class LocalSpeaker {
  constructor({ gallery, fetchImpl = (...args) => globalThis.fetch(...args), makeTap = createSpeakerTap, onState = () => {}, now = Date.now }) {
    Object.assign(this, { gallery, fetchImpl, makeTap, onState, now });
    this.enabled = false; this.turn = 0; this.generation = 0; this.ring = new SpeakerRing(); this.clearTurn();
  }
  clearTurn() { this.turn++; this.request?.abort(); this.request = null; this.pending = null; this.name = null; this.at = null; this.start = null; }
  async attach(context, stream) {
    this.detach(); if (!this.enabled) return;
    const generation = this.generation;
    try {
      const tap = await this.makeTap(context, stream, chunk => { if (generation === this.generation) this.ring.push(chunk); });
      if (generation !== this.generation || !this.enabled) { tap.close(); return; }
      this.tap = tap; this.onState('Stemherkenning luistert tijdens je gesprek.');
    } catch { if (generation === this.generation) this.onState('Stemherkenning kon niet starten; het gesprek kan doorgaan.'); }
  }
  detach() { this.generation++; this.tap?.close(); this.tap = null; this.ring.clear(); this.clearTurn(); }
  setEnabled(value) { this.enabled = Boolean(value); if (!this.enabled) this.detach(); }
  speech(active) {
    if (!this.enabled || !this.tap) return;
    if (active) { this.clearTurn(); this.start = Math.max(0, this.ring.total - 4800); return; }
    if (this.start === null) return;
    const samples = this.ring.take(this.start); this.start = null;
    if (samples.length < 16000 * 2) { samples.fill(0); this.onState('Te weinig spraak om je stem te herkennen.'); return; }
    const turn = this.turn, generation = this.generation, request = this.request = new AbortController();
    this.pending = this.embed(samples, request.signal).then(vector => {
      if (turn !== this.turn || generation !== this.generation || !this.enabled || request.signal.aborted) return;
      const match = this.gallery.match(vector); this.name = match?.name || null; this.at = this.now();
      this.onState(match ? `Mogelijke spreker: ${match.name}.` : 'Stem niet duidelijk herkend.');
    }).catch(() => { if (turn === this.turn && generation === this.generation) this.onState('Stem niet herkend; het gesprek kan doorgaan.'); });
  }
  async embed(samples, signal) {
    try {
      signal.throwIfAborted();
      const pcm = encodeSpeakerPcm(samples);
      const response = await this.fetchImpl('http://127.0.0.1:8787/speaker/embed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pcm, sampleRate: 16000 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw Error(await response.text());
      const result = await response.json(), vector = normalizedVoice(result.embedding);
      if (result.engine !== SPEAKER_ENGINE || !vector) throw Error('Ongeldig lokaal stemprofiel.');
      return vector;
    } finally { samples.fill(0); }
  }
  async status() {
    const turn = this.turn; await this.pending;
    const fresh = this.enabled && turn === this.turn && this.at !== null && this.now() - this.at < 15000;
    return { enabled: this.enabled, possible_speaker_name: fresh ? this.name : null, experimental: true };
  }
}
