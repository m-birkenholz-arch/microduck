import { createFaceEngine, loadFaceModels } from './face-engine.mjs';

export const FACE_STORAGE_KEY = 'microduck.faces.v1';
export const FACE_ENGINE = 'face-api-0.22.2';
export const cameraStatusTool = { type: 'function', name: 'get_camera_status',
  description: 'Lees de actuele lokale cameracontext voor je antwoord wanneer naamdelen aanstaat: herkende personen en een mogelijke spreker op basis van mondbeweging tijdens spraak. Start geen camera. Een mogelijke naam is onzekere lokale herkenning, geen bewijs van identiteit. Alleen na inschakelen van naamdelen komt een naam mee. Beeld en gezichtsprofielen zijn niet beschikbaar.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } };
export function descriptor(value) {
  if (!value || value.length !== 128) return null;
  const values = Array.from(value);
  if (!values.every(v => Number.isFinite(v) && Math.abs(v) <= 2)) return null;
  const norm = Math.hypot(...values);
  return norm > 0.1 && norm < 10 ? values : null;
}
export function distance(a, b) { return Math.hypot(...a.map((v, i) => v - b[i])); }
export class FaceGallery {
  constructor(storage, makeId = () => globalThis.crypto.randomUUID()) {
    this.storage = storage; this.makeId = makeId; this.profiles = []; this.loadError = '';
    try {
      const saved = JSON.parse(storage?.getItem(FACE_STORAGE_KEY) || 'null');
      if (saved?.engine === FACE_ENGINE && Array.isArray(saved.profiles)) {
        this.profiles = saved.profiles.filter(p => typeof p?.id === 'string' && p.id.length <= 80 &&
          typeof p.name === 'string' && p.name.trim() && p.name.length <= 60 && Array.isArray(p.samples) &&
          p.samples.length === 3 && p.samples.every(descriptor)).slice(0, 5)
          .map(p => ({ id: p.id, name: p.name.trim(), samples: p.samples.map(descriptor) }));
      }
    } catch { this.loadError = 'Gezichtsprofielen konden niet worden gelezen. Leer je gezicht opnieuw aan.'; }
  }
  write(profiles) {
    try {
      if (!this.storage) throw new Error();
      this.storage.setItem(FACE_STORAGE_KEY, JSON.stringify({ engine: FACE_ENGINE, profiles }));
    } catch { throw new Error('Gezichtsprofiel bewaren lukt niet. Controleer browseropslag.'); }
    this.profiles = profiles;
  }
  add(name, samples) {
    const label = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
    if (!label || label.length > 60) throw new Error('Vul je naam in (maximaal 60 tekens).');
    if (!Array.isArray(samples) || samples.length !== 3 || !samples.every(descriptor)) throw new Error('Er zijn drie geldige gezichtsmetingen nodig.');
    const clean = samples.map(descriptor);
    if (clean.some(sample => distance(sample, clean[0]) > 0.4)) throw new Error('Het gezicht veranderde te veel. Houd even stil en probeer opnieuw.');
    if (this.match(clean[0])) throw new Error('Deze meting lijkt op een bestaand gezichtsprofiel. Verwijder dat profiel als je het opnieuw wilt aanleren.');
    if (this.profiles.length >= 5) throw new Error('Er zijn al vijf gezichtsprofielen. Verwijder eerst een profiel.');
    if (this.profiles.some(p => p.name.toLowerCase() === label.toLowerCase())) throw new Error('Deze naam is al aangeleerd. Verwijder het oude profiel om opnieuw te leren.');
    const entry = { id: this.makeId(), name: label, samples: clean };
    this.write([...this.profiles, entry]); return entry;
  }
  remove(id) { this.write(this.profiles.filter(p => p.id !== id)); }
  clear() { this.write([]); }
  match(sample) {
    const v = descriptor(sample); if (!v) return null;
    const ranked = this.profiles.map(profile => ({ id: profile.id, name: profile.name,
      distance: Math.min(...profile.samples.map(saved => distance(v, saved))) })).sort((a, b) => a.distance - b.distance);
    const first = ranked[0];
    if (!first || first.distance > 0.45 || (ranked[1] && ranked[1].distance - first.distance < 0.08)) return null;
    return first;
  }
}

// Inner-lip separation divided by mouth width cancels camera distance and translation.
export function mouthOpening(face) {
  const points = face.landmarks?.getMouth?.();
  if (!points || points.length !== 20) return null;
  const gap = (a, b) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
  const width = gap(0, 6), value = (gap(13, 19) + gap(14, 18) + gap(15, 17)) / (3 * width);
  return width > 5 && Number.isFinite(value) ? value : null;
}

let enginePromise;
export function loadFaceEngine() {
  if (!enginePromise) enginePromise = (async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('Lokale cameramodellen laden duurde te lang.')); }, 30000);
      script.src = '/duck-face/face-api.min.js'; script.async = true;
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Cameramodellen ontbreken. Installeer de update met -FaceCamera.')); };
      document.head.append(script);
    });
    const api = globalThis.faceapi;
    if (!api?.nets) throw new Error('De lokale herkenningsbibliotheek kon niet starten. Installeer de update met -FaceCamera.');
    try { if (!await api.tf.setBackend('webgl')) await api.tf.setBackend('cpu'); }
    catch { await api.tf.setBackend('cpu'); }
    await loadFaceModels(api);
    return createFaceEngine(api);
  })().catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}

export class LocalFaceCamera {
  constructor({ video, gallery, mediaDevices = globalThis.navigator?.mediaDevices, makeEngine = loadFaceEngine,
    onState = () => {}, onResult = () => {}, schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    unschedule = timer => globalThis.clearTimeout(timer), now = Date.now }) {
    Object.assign(this, { video, gallery, mediaDevices, makeEngine, onState, onResult, schedule, unschedule, now });
    this.active = false; this.generation = 0; this.shareName = false; this.shareImage = false; this.recognitionError = ''; this.trackCleanup = []; this.reset();
  }
  reset() { this.recent = []; this.match = null; this.candidate = null; this.streak = 0; this.faceCount = 0; this.lastAt = null; this.people = []; this.tracks = new Map(); this.speaking = false; this.speaker = null; this.speakerAt = null; }
  async start() {
    this.stop(); const generation = this.generation; this.active = true;
    this.onState('Lokale gezichtsmodellen laden…');
    try {
      const engine = await this.makeEngine(); if (generation !== this.generation) return;
      this.engine = engine;
      if (!this.mediaDevices?.getUserMedia) throw new Error('Open de simulator op http://localhost:5173 in Chrome of Edge.');
      const stream = await this.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      for (const track of stream.getVideoTracks?.() || []) {
        const ended = () => { if (generation === this.generation) this.stop('De camera is door de browser of Windows gestopt. Start hem opnieuw als de toegang hersteld is.'); };
        track.addEventListener?.('ended', ended);
        this.trackCleanup.push(() => track.removeEventListener?.('ended', ended));
      }
      this.video.srcObject = stream; this.video.muted = true; this.video.playsInline = true;
      await this.video.play(); if (generation !== this.generation) return;
      this.onState(engine.backend === 'cpu' ? 'Camera aan — lokale CPU-herkenning actief (kan trager zijn).' : 'Camera aan — herkenning wordt lokaal uitgevoerd.');
      this.reportedBackend = engine.backend;
      await this.detect(engine, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      this.onState(error.name === 'NotAllowedError' ? 'Camera geweigerd. Geef cameratoegang en probeer opnieuw.' :
        error.name === 'NotFoundError' ? 'Geen laptopcamera gevonden.' :
        error.name === 'NotReadableError' ? 'Camera kon niet worden geopend. Controleer of een andere app hem gebruikt en of Windows cameratoegang toestaat.' : error.message || 'Camera kon niet starten.');
    }
  }
  async detect(engine, generation) {
    if (generation !== this.generation) return;
    try {
      const faces = await engine.detect(this.video);
      if (generation !== this.generation) return;
      if (engine.backend === 'cpu' && this.reportedBackend !== 'cpu') { this.reportedBackend = 'cpu'; this.onState('Camera aan — overgeschakeld naar lokale CPU-herkenning (kan trager zijn).'); }
      this.lastAt = this.now(); this.faceCount = faces.length; this.match = null;
      const previous = this.tracks; this.tracks = new Map(); this.people = [];
      const observations = faces.map(face => {
        const valid = descriptor(face.descriptor) && face.detection.score >= 0.8 && face.detection.box.width >= 100 && face.detection.box.height >= 100;
        return { face, match: valid ? this.gallery.match(face.descriptor) : null };
      });
      for (const { face, match } of observations) {
        // Duplicate matches in one frame are ambiguous, never two copies of one person.
        if (!match || observations.filter(o => o.match?.id === match.id).length !== 1) continue;
        const old = previous.get(match.id), opening = mouthOpening(face);
        const history = this.speaking ? [...(old?.history || []), { value: opening, at: this.lastAt }]
          .filter(p => p.value !== null && this.lastAt - p.at <= 2500).slice(-12) : [];
        const track = { ...match, streak: (old?.streak || 0) + 1, history };
        this.tracks.set(match.id, track);
        if (track.streak >= 3) this.people.push({ id: match.id, name: match.name });
      }
      if (this.speaking) this.updateSpeaker();
      else if (this.speaker && !this.people.some(p => p.id === this.speaker.id)) this.speaker = null;
      const face = faces.length === 1 ? faces[0] : null;
      const sample = face && descriptor(face.descriptor);
      const quality = sample && face.detection.score >= 0.8 && face.detection.box.width >= 100 && face.detection.box.height >= 100;
      if (quality) {
        this.recent.push(sample); this.recent = this.recent.slice(-3);
        const match = this.gallery.match(sample);
        this.streak = match && match.id === this.candidate ? this.streak + 1 : match ? 1 : 0;
        this.candidate = match?.id || null;
        if (this.streak >= 3) this.match = match;
      } else { this.recent = []; this.streak = 0; this.candidate = null; }
      this.onResult({ faces, match: this.match, learnReady: this.recent.length === 3,
        people: this.people, speaker: this.speaker, message: !faces.length ? 'Geen gezicht in beeld.' : faces.length > 1 ? `Gezichten: ${faces.length}. Herkend: ${this.people.map(p => p.name).join(', ') || 'nog niemand'}. Aanleren kan alleen met één gezicht.` :
          !quality ? 'Kom iets dichterbij, kijk recht vooruit en zorg voor goed licht.' : this.match ? `Lijkt op ${this.match.name} (herkenningsproef).` :
          this.candidate ? 'Mogelijke herkenning controleren…' : 'Gezicht gezien, nog niet herkend.' });
      if (generation === this.generation && this.active) this.timer = this.schedule(() => { this.timer = null; void this.detect(engine, generation); }, 250);
    } catch (error) {
      if (generation === this.generation) {
        this.reset();
        this.recognitionError = String(error?.message || 'Onbekende herkenningsfout').replace(/\s+/g, ' ').slice(0, 240);
        this.onResult({ faces: [], match: null, learnReady: false, message: 'Herkenning gepauzeerd — geen naam beschikbaar.' });
        this.onState(`Camera blijft aan. Herkenning gepauzeerd: ${this.recognitionError}. Klik op Herkenning opnieuw proberen.`);
      }
    }
  }
  updateSpeaker() {
    const moving = [...this.tracks.values()].filter(track => {
      const h = track.history;
      if (track.streak < 3 || h.length < 3 || h.at(-1).at - h[0].at < 400) return false;
      const changes = h.slice(1).filter((p, i) => Math.abs(p.value - h[i].value) > 0.025).length;
      return changes >= 2 && Math.max(...h.map(p => p.value)) - Math.min(...h.map(p => p.value)) > 0.06;
    });
    // Unknown faces could be speaking too. Withhold attribution rather than guessing.
    this.speaker = moving.length === 1 && this.people.length === this.faceCount ? { id: moving[0].id, name: moving[0].name } : null;
    this.speakerAt = this.now();
  }
  setSpeechActive(active) {
    if (active) { this.speaker = null; this.speakerAt = null; for (const track of this.tracks.values()) track.history = []; }
    this.speaking = Boolean(active && this.active);
  }
  async retry() {
    if (!this.active || !this.engine || !this.recognitionError) return;
    this.recognitionError = ''; this.reset();
    this.onState('Camera aan — herkenning opnieuw proberen…');
    await this.detect(this.engine, this.generation);
  }
  learn(name) {
    if (!this.active || this.recent.length !== 3 || this.now() - this.lastAt > 5000) throw new Error('Houd één gezicht even duidelijk in beeld tot Aanleren beschikbaar is.');
    const result = this.gallery.add(name, this.recent); this.reset(); return result;
  }
  status() {
    if (!this.active) return { camera_active: false, image_sharing: false, message: 'De laptopcamera staat uit.' };
    const fresh = typeof this.lastAt === 'number' && this.now() - this.lastAt <= 5000;
    return { camera_active: true, image_sharing: this.shareImage, face_count: fresh ? this.faceCount : null, name_sharing: this.shareName, recognition_available: !this.recognitionError && fresh,
      possibly_recognized_name: this.shareName && fresh ? this.match?.name || null : null,
      recognized_people: this.shareName && fresh ? this.people.map(p => ({ name: p.name })) : [],
      possible_speaker_name: this.shareName && fresh && this.speakerAt !== null && this.now() - this.speakerAt < 15000 ? this.speaker?.name || null : null,
      speaker_method: 'experimental_mouth_motion_during_detected_speech',
      experimental: true, message: this.recognitionError ? 'De herkenning is gepauzeerd; er is geen naam beschikbaar.' : !this.shareName ? 'Naam delen staat uit; gezichtsprofielen blijven lokaal.' : 'Lokale herkenning actief.' };
  }
  stop(reason = 'Camera uit — geen beelden worden verwerkt.') {
    this.generation++; this.active = false; this.shareName = false; this.shareImage = false; this.recognitionError = ''; this.engine = null;
    for (const remove of this.trackCleanup) remove(); this.trackCleanup = [];
    if (this.timer) this.unschedule(this.timer); this.timer = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.video.pause(); this.video.srcObject = null; this.reset();
    this.onResult({ faces: [], match: null, learnReady: false, message: 'Camera uit.' });
    this.onState(reason);
  }
}
