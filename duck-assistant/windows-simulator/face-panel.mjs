import { FaceGallery, LocalFaceCamera } from './face-local.mjs';

export function mountFacePanel({ container, storage, defaultName = '', onActivity = () => {}, onGreet = () => {}, cameraOptions = {} }) {
  const section = document.createElement('details');
  section.id = 'face-test';
  section.innerHTML = `
    <summary>Laptopcamera en gezichtsherkenning</summary>
    <p class="hint">Lokale proef. Beelden en gezichtsprofielen worden niet naar OpenAI of Google gestuurd. Start de camera zelf; Stop alles of tab verbergen sluit hem af.</p>
    <div id="face-preview" hidden style="position:relative">
      <video id="face-video" width="640" height="480" muted playsinline style="display:block;width:100%;height:auto;transform:scaleX(-1)"></video>
      <canvas id="face-overlay" width="640" height="480" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;transform:scaleX(-1)"></canvas>
    </div>
    <div class="actions"><button id="face-start">Camera starten</button><button id="face-stop" disabled>Camera stoppen</button></div>
    <p id="face-state" role="status" class="hint">Camera uit</p>
    <p id="face-result" role="status"></p>
    <p><label>Naam voor je eigen gezicht<input id="face-name" type="text" maxlength="60"></label></p>
    <button id="face-learn" disabled>Leer mijn gezicht</button>
    <p class="hint">Houd één gezicht duidelijk in beeld tot Aanleren beschikbaar is. Deze knop bewaart drie numerieke gezichtsmetingen en je naam in deze browser, geen foto's. Leer alleen je eigen gezicht aan of dat van iemand die hiervoor toestemming geeft.</p>
    <p><label><input id="face-share" type="checkbox" disabled> Duck mag de herkende naam gebruiken</label></p>
    <button id="face-greet" disabled>Laat Duck mij begroeten</button>
    <p class="hint">Met naamdelen kan de gesprekshulp alleen aantallen en een mogelijke naam lezen wanneer je ernaar vraagt; geen beeld of gezichtsprofiel. Een eerder gedeelde naam kan nog in het lopende gesprek staan. Herkenning kan zich vergissen en een foto kan voor een gezicht doorgaan. Gebruik dit niet als toegangsbeveiliging.</p>
    <details><summary>Mijn gezichtsprofielen</summary><div id="face-profiles"></div><button id="face-clear">Wis alle gezichtsprofielen</button></details>`;
  container.insertBefore(section, container.querySelector('#settings-state'));
  const $ = selector => section.querySelector(selector), gallery = new FaceGallery(storage);
  $('#face-name').value = defaultName;
  const camera = new LocalFaceCamera({ ...cameraOptions, video: $('#face-video'), gallery,
    onState(message) {
      $('#face-state').textContent = message;
      $('#face-start').disabled = camera.active; $('#face-stop').disabled = !camera.active;
      $('#face-share').disabled = !camera.active;
      if (!camera.active) $('#face-share').checked = false;
      $('#face-preview').hidden = !camera.active;
      onActivity();
    },
    onResult({ faces, match, learnReady, message }) {
      $('#face-result').textContent = message;
      $('#face-learn').disabled = !learnReady;
      $('#face-greet').disabled = !match || !camera.shareName;
      const canvas = $('#face-overlay');
      canvas.width = $('#face-video').videoWidth || 640; canvas.height = $('#face-video').videoHeight || 480;
      const context = canvas.getContext('2d');
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = match ? '#74dc99' : '#ffdc70'; context.lineWidth = 3;
        for (const face of faces) { const b = face.detection.box; context.strokeRect(b.x, b.y, b.width, b.height); }
      }
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
    $('#face-greet').disabled = !camera.match || !camera.shareName;
  });
  $('#face-greet').addEventListener('click', () => {
    if (camera.shareName && camera.status().possibly_recognized_name) onGreet();
  });
  profiles();
  if (gallery.loadError) $('#face-state').textContent = gallery.loadError;
  return { camera, gallery, open() { section.open = true; section.scrollIntoView?.({ block: 'nearest' }); }, dispose() { camera.stop(); section.remove(); } };
}
