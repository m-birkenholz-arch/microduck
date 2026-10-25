import { captureCamera } from './vision.mjs';
import { FaceGallery, LocalFaceCamera } from './face-local.mjs';

export function drawFaceOverlay(canvas, video, faces, match) {
  try {
    canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480;
    const context = canvas.getContext('2d');
    if (!context) { canvas.hidden = true; return false; }
    canvas.hidden = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = match ? '#74dc99' : '#ffdc70'; context.lineWidth = 3;
    for (const face of faces) { const b = face.detection.box; context.strokeRect(b.x, b.y, b.width, b.height); }
    return true;
  } catch { canvas.hidden = true; return false; } // A rectangle must never stop video or recognition.
}

export function mountFacePanel({ container, storage, defaultName = '', onActivity = () => {}, onGreet = () => {}, onContext = () => {}, onView = () => {}, cameraOptions = {} }) {
  const section = document.createElement('details');
  section.id = 'face-test';
  section.innerHTML = `
    <summary>Laptopcamera en gezichtsherkenning</summary>
    <p class="hint">Lokale proef. Gezichtsherkenning blijft lokaal. Alleen met de aparte optie voor Google-beeldanalyse wordt op jouw verzoek een camerabeeld gedeeld. Start de camera zelf; Stop alles of tab verbergen sluit hem af.</p>
    <div id="face-preview" hidden style="position:relative">
      <video id="face-video" width="640" height="480" muted playsinline style="display:block;width:100%;height:auto;transform:scaleX(-1)"></video>
      <canvas id="face-overlay" width="640" height="480" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;transform:scaleX(-1)"></canvas>
    </div>
    <div class="actions"><button id="face-start">Camera starten</button><button id="face-stop" disabled>Camera stoppen</button><button id="face-retry" disabled>Herkenning opnieuw proberen</button></div>
    <p id="face-state" role="status" class="hint">Camera uit</p>
    <p id="face-result" role="status"></p>
    <p><label>Naam voor je eigen gezicht<input id="face-name" type="text" maxlength="60"></label></p>
    <button id="face-learn" disabled>Leer mijn gezicht</button>
    <p class="hint">Houd één gezicht duidelijk in beeld tot Aanleren beschikbaar is. Deze knop bewaart drie numerieke gezichtsmetingen en je naam in deze browser, geen foto's. Leer alleen je eigen gezicht aan of dat van iemand die hiervoor toestemming geeft.</p>
    <p><label><input id="face-share" type="checkbox" disabled> Duck mag de herkende naam gebruiken</label></p>
    <button id="face-greet" disabled>Laat Duck mij begroeten</button>
    <p class="hint">Met naamdelen kan de gesprekshulp automatisch mogelijke namen en een mogelijke spreker gebruiken tijdens het gesprek; geen beeld of gezichtsprofiel. Sprekerherkenning is een proef met mondbeweging tijdens spraak, geen stemherkenning. Bij twijfel vraagt Duck wie praat. Een eerder gedeelde naam kan nog in het lopende gesprek staan. Herkenning kan zich vergissen en een foto kan voor een gezicht doorgaan. Gebruik dit niet als toegangsbeveiliging.</p>
    <p><label><input id="vision-share" type="checkbox" disabled> Camerabeelden delen met Google</label></p>
    <button id="vision-view" disabled>Bekijk dit</button>
    <p class="hint">Bij “Bekijk dit” of een vraag over wat je laat zien, wordt één camerabeeld naar Google Gemini gestuurd. De beschrijving gaat naar de gesprekshulp. Geen doorlopende upload; je kunt deze toestemming hier uitzetten. API-gebruik kan geld kosten.</p>
    <details><summary>Mijn gezichtsprofielen</summary><div id="face-profiles"></div><button id="face-clear">Wis alle gezichtsprofielen</button></details>`;
  container.insertBefore(section, container.querySelector('#settings-state'));
  const $ = selector => section.querySelector(selector), gallery = new FaceGallery(storage);
  $('#face-name').value = defaultName;
  const camera = new LocalFaceCamera({ ...cameraOptions, video: $('#face-video'), gallery,
    onState(message) {
      $('#face-state').textContent = message;
      $('#face-start').disabled = camera.active; $('#face-stop').disabled = !camera.active;
      $('#face-retry').disabled = !camera.active || !camera.recognitionError;
      $('#face-share').disabled = !camera.active;
      $('#vision-share').disabled = !camera.active;
      if (!camera.active) { $('#face-share').checked = false; $('#vision-share').checked = false; }
      $('#vision-view').disabled = !camera.active || !camera.shareImage;
      $('#face-preview').hidden = !camera.active;
      onActivity(); onContext();
    },
    onResult({ faces, match, learnReady, message, speaker }) {
      $('#face-result').textContent = message + (speaker ? ` Mogelijke spreker: ${speaker.name}.` : '');
      onContext();
      $('#face-learn').disabled = !learnReady;
      $('#face-greet').disabled = !match || !camera.shareName;
      drawFaceOverlay($('#face-overlay'), $('#face-video'), faces, match);
    },
  });
  function profiles() {
    const list = $('#face-profiles'); list.replaceChildren();
    if (!gallery.profiles.length) list.textContent = 'Nog geen gezichtsprofielen.';
    for (const profile of gallery.profiles) {
      const row = document.createElement('p'), name = document.createElement('span'), remove = document.createElement('button');
      name.textContent = profile.name + ' '; remove.textContent = 'Verwijderen';
      remove.setAttribute('aria-label', `Verwijder gezichtsprofiel ${profile.name}`);
      remove.addEventListener('click', () => {
        try { gallery.remove(profile.id); camera.stop(); profiles(); $('#face-result').textContent = 'Gezichtsprofiel verwijderd.'; }
        catch (error) { $('#face-state').textContent = error.message; }
      });
      row.append(name, remove); list.append(row);
    }
  }
  $('#face-start').addEventListener('click', () => { void camera.start(); });
  $('#face-stop').addEventListener('click', () => camera.stop());
  $('#face-retry').addEventListener('click', () => { void camera.retry(); });
  $('#face-learn').addEventListener('click', () => {
    try {
      camera.learn($('#face-name').value); profiles();
      $('#face-learn').disabled = $('#face-greet').disabled = true;
      $('#face-result').textContent = 'Gezichtsprofiel lokaal bewaard. Even wachten op herkenning…';
    } catch (error) { $('#face-state').textContent = error.message; }
  });
  $('#face-clear').addEventListener('click', () => {
    try { gallery.clear(); camera.stop(); profiles(); $('#face-result').textContent = 'Alle gezichtsprofielen gewist.'; }
    catch (error) { $('#face-state').textContent = error.message; }
  });
  $('#face-share').addEventListener('change', event => {
    camera.shareName = event.target.checked;
    onContext();
    $('#face-greet').disabled = !camera.match || !camera.shareName;
  });
  $('#vision-share').addEventListener('change', event => {
    camera.shareImage = event.target.checked;
    $('#vision-view').disabled = !camera.active || !camera.shareImage;
    onContext();
  });
  $('#vision-view').addEventListener('click', () => onView());
  $('#face-greet').addEventListener('click', () => {
    if (camera.shareName && camera.status().possibly_recognized_name) onGreet();
  });
  profiles();
  if (gallery.loadError) $('#face-state').textContent = gallery.loadError;
  return { camera, gallery, capture() { return captureCamera($('#face-video'), { allowed: camera.active && camera.shareImage }); }, open() { section.open = true; section.scrollIntoView?.({ block: 'nearest' }); }, dispose() { camera.stop(); section.remove(); } };
}
