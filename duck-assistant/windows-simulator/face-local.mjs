export const FACE_STORAGE_KEY = 'microduck.faces.v1';
export const FACE_ENGINE = 'face-api-0.22.2';
export const cameraStatusTool = { type: 'function', name: 'get_camera_status',
  description: 'Lees de lokale laptopcameratest als de gebruiker vraagt of je een gezicht ziet of iemand herkent. Start geen camera. Een mogelijke naam is onzekere lokale herkenning, geen bewijs van identiteit. Alleen na inschakelen van naamdelen komt een naam mee. Beeld en gezichtsprofielen zijn niet beschikbaar.',
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
    let loadTimer;
    try { await Promise.race([new Promise((resolve, reject) => { loadTimer = setTimeout(() => reject(new Error('Lokale gezichtsmodellen laden duurde te lang. Installeer opnieuw met -FaceCamera.')), 45000); }),
      Promise.all([api.nets.tinyFaceDetector.loadFromUri('/duck-face/models'),
      api.nets.faceLandmark68TinyNet.loadFromUri('/duck-face/models'), api.nets.faceRecognitionNet.loadFromUri('/duck-face/models')])]); }
    finally { clearTimeout(loadTimer); }
    return { detect: video => api.detectAllFaces(video, new api.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.75 }))
      .withFaceLandmarks(true).withFaceDescriptors() };
  })().catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}

export class LocalFaceCamera {
  constructor({ video, gallery, mediaDevices = globalThis.navigator?.mediaDevices, makeEngine = loadFaceEngine,
    onState = () => {}, onResult = () => {}, schedule = setTimeout, unschedule = clearTimeout, now = Date.now }) {
    Object.assign(this, { video, gallery, mediaDevices, makeEngine, onState, onResult, schedule, unschedule, now });
    this.active = false; this.generation = 0; this.shareName = false; this.reset();
  }
  reset() { this.recent = []; this.match = null; this.candidate = null; this.streak = 0; this.faceCount = 0; this.lastAt = null; }
  async start() {
    this.stop(); const generation = this.generation; this.active = true;
    this.onState('Lokale gezichtsmodellen laden…');
    try {
      const engine = await this.makeEngine(); if (generation !== this.generation) return;
      if (!this.mediaDevices?.getUserMedia) throw new Error('Open de simulator op http://localhost:5173 in Chrome of Edge.');
      const stream = await this.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream; this.video.srcObject = stream; this.video.muted = true; this.video.playsInline = true;
      await this.video.play(); if (generation !== this.generation) return;
      this.onState('Camera aan — herkenning wordt lokaal uitgevoerd.');
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
      this.lastAt = this.now(); this.faceCount = faces.length; this.match = null;
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
        message: !faces.length ? 'Geen gezicht in beeld.' : faces.length > 1 ? 'Meerdere gezichten — ga alleen voor de camera zitten.' :
          !quality ? 'Kom iets dichterbij, kijk recht vooruit en zorg voor goed licht.' : this.match ? `Lijkt op ${this.match.name} (herkenningsproef).` :
          this.candidate ? 'Mogelijke herkenning controleren…' : 'Gezicht gezien, nog niet herkend.' });
      if (generation === this.generation && this.active) this.timer = this.schedule(() => { this.timer = null; void this.detect(engine, generation); }, 750);
    } catch (error) {
      if (generation === this.generation) { this.stop(); this.onState('Lokale herkenning gestopt. Probeer de camera opnieuw te starten.'); }
    }
  }
  learn(name) {
    if (!this.active || this.recent.length !== 3 || this.now() - this.lastAt > 5000) throw new Error('Houd één gezicht even duidelijk in beeld tot Aanleren beschikbaar is.');
    const result = this.gallery.add(name, this.recent); this.reset(); return result;
  }
  status() {
    if (!this.active) return { camera_active: false, message: 'De laptopcamera staat uit.' };
    const fresh = typeof this.lastAt === 'number' && this.now() - this.lastAt <= 5000;
    return { camera_active: true, face_count: fresh ? this.faceCount : null, name_sharing: this.shareName,
      possibly_recognized_name: this.shareName && fresh ? this.match?.name || null : null,
      experimental: true, message: !this.shareName ? 'Naam delen staat uit; beelden en gezichtsprofielen blijven lokaal.' : 'Lokale, onzekere herkenning. Geen identiteitsbewijs.' };
  }
  stop() {
    this.generation++; this.active = false; this.shareName = false;
    if (this.timer) this.unschedule(this.timer); this.timer = null;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.video.pause(); this.video.srcObject = null; this.reset();
    this.onResult({ faces: [], match: null, learnReady: false, message: 'Camera uit.' });
    this.onState('Camera uit — geen beelden worden verwerkt.');
  }
}
