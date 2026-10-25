import { DuckConversation } from './client.mjs';
import { setConversationJaw } from './mouth.mjs';
import { conversationMotion } from './motion.mjs';

const host = document.createElement('aside');
host.id = 'duck-conversation-panel';
host.setAttribute('aria-label', 'Praat met Microduck');
const root = host.attachShadow({ mode: 'open' });
root.innerHTML = `
<style>
 :host{position:fixed;right:16px;top:16px;z-index:2147483647;width:min(320px,calc(100vw - 32px));font:14px/1.45 system-ui,sans-serif;color:#f7f5ee}
 section{background:#191c23f5;border:1px solid #696b70;border-radius:16px;padding:18px;box-shadow:0 8px 32px #0006}
 h2{font-size:18px;margin:0 0 6px} p{margin:6px 0} .hint{color:#c8c9cc;font-size:12px}
 button{border:0;border-radius:9px;padding:10px 14px;font:600 14px system-ui;cursor:pointer;background:#ffdc70;color:#181818}
 button:disabled{opacity:.45;cursor:default} button+button{margin-left:6px;background:#414650;color:white}
 .actions{margin:14px 0} #status{min-height:40px;overflow-wrap:anywhere} #text{max-height:150px;overflow:auto;color:#eee}
 progress{width:100%;height:8px;accent-color:#ffdc70} a{color:#ffdc70}
 input[type=range]{width:100%;accent-color:#ffdc70} output{font-variant-numeric:tabular-nums}
</style>
<section>
 <h2>Praat met Microduck</h2>
 <p class="hint">Nederlands gesprek · gebruik bij voorkeur een koptelefoon</p>
 <div class="actions"><button id="start">Start gesprek</button><button id="stop" disabled>Stop</button></div>
 <p id="status" role="status" aria-live="polite">Klaar om te praten</p>
 <progress id="level" max="1" value="0" aria-label="Stemvolume Microduck"></progress>
 <p class="hint"><label><input id="motion" type="checkbox" checked> Hoofd en nek bewegen mee</label></p>
 <p class="hint"><label><input id="body-motion" type="checkbox" checked> Lichaam beweegt mee</label></p>
 <p class="hint"><label for="strength">Sterkte beweging: <output id="strength-value">3×</output></label>
 <input id="strength" type="range" min="1" max="4" step="0.5" value="3" aria-label="Sterkte lichaamsreacties"></p>
 <p id="text"></p>
 <p class="hint">Je microfoon blijft tijdens het gesprek open. Klik op Stop om af te sluiten. OpenAI API-gebruik kost apart geld.</p>
</section>`;
const start = root.querySelector('#start');
const stop = root.querySelector('#stop');
const conversation = new DuckConversation({
  onStatus(message, active) {
    root.querySelector('#status').textContent = message;
    start.disabled = active;
    stop.disabled = !active;
  },
  onText(text) { root.querySelector('#text').textContent = text; },
  onLevel(level) {
    root.querySelector('#level').value = level;
    setConversationJaw(level);
    conversationMotion.setLevel(level);
  },
  onPhase(phase) { conversationMotion.setPhase(phase); },
  onGesture(kind) { conversationMotion.triggerGesture(kind); },
});
root.querySelector('#motion').addEventListener('change', event => {
  conversationMotion.enabled = event.target.checked;
  root.querySelector('#strength').disabled = !conversationMotion.enabled && !conversationMotion.bodyEnabled;
});
root.querySelector('#body-motion').addEventListener('change', event => {
  conversationMotion.bodyEnabled = event.target.checked;
  root.querySelector('#strength').disabled = !conversationMotion.enabled && !conversationMotion.bodyEnabled;
});
root.querySelector('#strength').addEventListener('input', event => {
  conversationMotion.setStrength(Number(event.target.value));
  root.querySelector('#strength-value').textContent = `${conversationMotion.strength}×`;
});
// Keep UI events away from the simulator's keyboard/gamepad gesture handlers.
for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click']) {
  host.addEventListener(type, event => event.stopPropagation());
}
start.addEventListener('click', () => conversation.start());
stop.addEventListener('click', () => conversation.stop());
document.body.append(host);
const cleanup = () => { conversation.stop(); host.remove(); };
window.addEventListener('pagehide', cleanup, { once: true });
if (import.meta.hot) import.meta.hot.dispose(cleanup);
