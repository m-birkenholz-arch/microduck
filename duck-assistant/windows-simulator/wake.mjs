const normalize = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function wakeMatch(transcript, name = 'Duck') {
  const words = normalize(transcript).split(' '), duck = normalize(name).split(' ');
  for (let i = 0; i < words.length - duck.length; i++) {
    if (['he', 'hee', 'hey', 'hoi'].includes(words[i]) && duck.every((word, n) => word === words[i + n + 1])) {
      return { remainder: words.slice(i + 1 + duck.length).join(' ') };
    }
  }
  return null;
}
export class WakeWord {
  constructor({ makeRecognition = () => {
    const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!Recognition) throw new Error('Dit wekwoord werkt hier niet. Gebruik Chrome of Edge, of Start gesprek.');
    return new Recognition();
  }, getName = () => 'Duck', onWake = () => {}, onState = () => {}, schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    unschedule = timer => globalThis.clearTimeout(timer) } = {}) {
    Object.assign(this, { makeRecognition, getName, onWake, onState, schedule, unschedule });
    this.enabled = false; this.paused = true; this.generation = 0;
  }
  enable() { this.enabled = true; this.paused = false; this.listen(); }
  listen() {
    if (!this.enabled || this.paused || this.recognition || this.timer) return;
    const generation = this.generation;
    try {
      const r = this.recognition = this.makeRecognition();
      r.lang = 'nl-NL'; r.continuous = true; r.interimResults = false;
      r.onresult = event => {
        if (generation !== this.generation || this.paused || !this.enabled) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (!event.results[i].isFinal) continue;
          const match = wakeMatch(event.results[i][0].transcript, this.getName());
          if (match) { this.pause(); this.onWake(match); break; }
        }
      };
      r.onerror = event => {
        if (generation !== this.generation) return;
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        this.disable(); this.onState(`Wekwoord gestopt (${event.error}). Gebruik Start gesprek of schakel het opnieuw in.`);
      };
      r.onend = () => {
        if (generation !== this.generation) return;
        this.recognition = null;
        if (this.enabled && !this.paused) this.timer = this.schedule(() => { this.timer = null; this.listen(); }, 500);
      };
      r.start(); this.onState(`Luistert naar “Hé ${this.getName()}”`);
    } catch (error) { this.disable(); this.onState(error.message); }
  }
  pause() {
    this.paused = true; this.generation++;
    if (this.timer) this.unschedule(this.timer); this.timer = null;
    const r = this.recognition; this.recognition = null;
    if (r) { r.onresult = r.onend = r.onerror = null; r.abort(); }
  }
  resume() { if (this.enabled) { this.paused = false; this.listen(); } }
  disable() { this.enabled = false; this.pause(); this.onState('Wekwoord uit — microfoon voor wekwoord gesloten'); }
}
