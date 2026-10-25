import { SpeakerGallery, LocalSpeaker, SpeakerRing, createSpeakerTap } from './speaker-local.mjs';

export function waitRecording(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(new Error('Stemopname gestopt.')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
export async function recordSpeakerSample(signal, { mediaDevices = globalThis.navigator.mediaDevices,
  makeContext = () => new AudioContext(), makeTap = createSpeakerTap, wait = waitRecording } = {}) {
  let stream, context, tap; const ring = new SpeakerRing();
  try {
    signal.throwIfAborted();
    stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    signal.throwIfAborted(); context = makeContext(); await context.resume();
    tap = await makeTap(context, stream, chunk => ring.push(chunk)); signal.throwIfAborted();
    await wait(6000, signal); signal.throwIfAborted();
    return ring.take();
  } finally { tap?.close(); ring.clear(); stream?.getTracks().forEach(track => track.stop()); await context?.close().catch(() => {}); }
}

export function mountSpeakerPanel({ container, storage, defaultName = '', beforeEnroll = () => {}, onChange = () => {},
  getMicrophone = () => ({}), fetchImpl = (...args) => globalThis.fetch(...args), record = recordSpeakerSample, speakerOptions = {} }) {
  const section = document.createElement('details'); section.id = 'speaker-panel';
  section.innerHTML = `<summary>Herkennen aan je stem</summary>
    <p class="hint">Lokale stemherkenning op deze laptop. Drie korte opnames worden omgezet in een numeriek stemprofiel. De opnames worden niet bewaard. Leer je eigen stem aan, of die van iemand die hiervoor toestemming geeft.</p>
    <label>Naam<input id="speaker-name" type="text" maxlength="60"></label>
    <p><label><input id="speaker-enroll-consent" type="checkbox"> Ik wil deze stem lokaal aanleren en bewaren</label></p>
    <button id="speaker-enroll" disabled>Leer mijn stem</button><button id="speaker-cancel" disabled>Opname stoppen</button>
    <p class="hint">Na klikken spreek je drie keer ongeveer zes seconden. Vertel bijvoorbeeld iets over je dag. Spreek alleen, met weinig achtergrondgeluid. Het gesprek pauzeert tijdens aanleren.</p>
    <p><label><input id="speaker-enabled" type="checkbox"> Herken mijn stem en laat Duck mijn naam gebruiken</label></p>
    <p class="hint">Alleen tijdens een gestart gesprek. Een mogelijke naam gaat naar de gesprekshulp; het stemprofiel blijft lokaal. Bij twijfel gebruikt Duck geen naam. Geen toegangsbeveiliging: korte spraak, Nederlands, ruis, andere microfoons en tegelijk praten moeten in de praktijk worden getest.</p>
    <p id="speaker-state" role="status">Stemherkenning uit. Leer je stem aan of schakel herkenning in.</p>
    <div id="speaker-profiles"></div><button id="speaker-clear">Wis alle stemprofielen</button>`;
  container.insertBefore(section, container.querySelector('#settings-state'));
  const $ = id => section.querySelector('#' + id), gallery = new SpeakerGallery(storage);
  $('speaker-name').value = defaultName;
  let enrolling, generation = 0;
  const speaker = new LocalSpeaker({ gallery, fetchImpl, ...speakerOptions,
    onState(message) { $('speaker-state').textContent = message; onChange(); } });
  const render = () => {
    const list = $('speaker-profiles'); list.replaceChildren();
    if (!gallery.profiles.length) list.textContent = 'Nog geen stemprofielen.';
    for (const profile of gallery.profiles) {
      const row = document.createElement('p'), name = document.createElement('span'), remove = document.createElement('button');
      name.textContent = profile.name + ' '; remove.textContent = 'Verwijderen';
      remove.addEventListener('click', () => { try { stop(); gallery.remove(profile.id); render(); } catch (error) { $('speaker-state').textContent = error.message; } });
      row.append(name, remove); list.append(row);
    }
  };
  function stop() {
    generation++; enrolling?.abort(); enrolling = null; speaker.setEnabled(false);
    $('speaker-enabled').checked = false; $('speaker-enroll-consent').checked = false;
    $('speaker-enroll').disabled = true; $('speaker-cancel').disabled = true;
    $('speaker-enabled').disabled = false; $('speaker-state').textContent = 'Stemherkenning uit.'; onChange();
  }
  $('speaker-enroll-consent').addEventListener('change', () => { if (enrolling && !$('speaker-enroll-consent').checked) stop(); $('speaker-enroll').disabled = !$('speaker-enroll-consent').checked || Boolean(enrolling); });
  $('speaker-enroll').addEventListener('click', async () => {
    if (!$('speaker-enroll-consent').checked || enrolling) return;
    const name = $('speaker-name').value.trim();
    if (!name || name.length > 60) { $('speaker-state').textContent = 'Vul eerst je naam in.'; return; }
    if (gallery.profiles.length >= 5 || gallery.profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) { $('speaker-state').textContent = 'Verwijder eerst het bestaande profiel of een van de vijf profielen.'; return; }
    beforeEnroll();
    $('speaker-enroll-consent').checked = true;
    const attempt = ++generation, controller = enrolling = new AbortController();
    $('speaker-enroll').disabled = true; $('speaker-cancel').disabled = false; $('speaker-enabled').disabled = true; onChange();
    const samples = [];
    try {
      const health = await fetchImpl('http://127.0.0.1:8787/health', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (!health.ok || !(await health.json()).speakerRecognition) throw Error('Stemmodel ontbreekt. Installeer met -SpeakerRecognition en start de gesprekshulp opnieuw.');
      for (let n = 1; n <= 3; n++) {
        if (attempt !== generation) return;
        $('speaker-state').textContent = `Opname ${n}/3 — praat ongeveer zes seconden over je dag…`;
        const pcm = await record(controller.signal);
        $('speaker-state').textContent = `Opname ${n}/3 lokaal verwerken…`;
        samples.push(await speaker.embed(pcm, controller.signal));
      }
      if (attempt !== generation || controller.signal.aborted) return;
      gallery.add(name, samples); render(); $('speaker-state').textContent = 'Stemprofiel bewaard. Vink stemherkenning aan en start een gesprek.';
    } catch (error) { if (attempt === generation) $('speaker-state').textContent = error.name === 'NotAllowedError' ? 'Geef microfoontoegang en probeer opnieuw.' : error.message; }
    finally {
      samples.forEach(v => v.fill(0));
      if (attempt === generation) { enrolling = null; $('speaker-enroll-consent').checked = false; $('speaker-enroll').disabled = true; $('speaker-cancel').disabled = true; $('speaker-enabled').disabled = false; onChange(); }
    }
  });
  $('speaker-cancel').addEventListener('click', stop);
  $('speaker-enabled').addEventListener('change', async () => {
    speaker.setEnabled($('speaker-enabled').checked);
    if (speaker.enabled && !gallery.profiles.length) { stop(); $('speaker-state').textContent = 'Leer eerst je stem aan.'; return; }
    onChange();
    if (speaker.enabled) {
      const attempt = generation;
      try {
        const response = await fetchImpl('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(5000) });
        if (!response.ok || !(await response.json()).speakerRecognition) throw Error('Stemmodel ontbreekt. Installeer met -SpeakerRecognition en start de gesprekshulp opnieuw.');
      } catch (error) { if (attempt === generation) { stop(); $('speaker-state').textContent = error.message; } return; }
      if (attempt !== generation || !speaker.enabled) return;
      const { context, stream } = getMicrophone();
      if (context && stream) await speaker.attach(context, stream);
      else $('speaker-state').textContent = 'Stemherkenning klaar. Start een gesprek.';
    } else $('speaker-state').textContent = 'Stemherkenning uit.';
  });
  $('speaker-clear').addEventListener('click', () => { try { stop(); gallery.clear(); render(); } catch (error) { $('speaker-state').textContent = error.message; } });
  render(); if (gallery.error) $('speaker-state').textContent = gallery.error;
  return { speaker, open() { section.open = true; section.scrollIntoView?.({ block: 'nearest' }); }, get busy() { return Boolean(enrolling); }, cancelEnrollment() { if (enrolling) stop(); }, stop, dispose() { stop(); section.remove(); } };
}
