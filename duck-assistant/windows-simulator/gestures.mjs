// Conservative opening-clause cues, not a general sentiment classifier. Only
// the duck's generated audio transcript is used, never the user's input.
export function answerGesture(text, complete = false) {
  const raw = String(text).trimStart();
  // Quoted/example speech and open questions are not the duck's own yes/no.
  if (/^["'“‘«>]/u.test(raw)) return null;
  const boundary = /[,.;!?\n]/u.exec(raw);
  if (!boundary && !complete) return null; // A split "Dat klopt niet" must not nod early.
  if (boundary?.[0] === '?') return null;
  const clause = (boundary ? raw.slice(0, boundary.index) : raw).toLowerCase()
    .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (/\b(?:misschien|wellicht|mogelijk|waarschijnlijk|niet zeker|noch ja noch nee|ja noch nee)\b/u.test(clause)) return null;
  const negative = /^(?:nee|neen|no)\b/u.test(clause) ||
    /^(?:absoluut|zeker|beslist|klopt)(?: helemaal)? niet\b/u.test(clause) ||
    /^(?:dat|dit|het) (?:klopt(?: helemaal)? niet|is(?: helemaal)? (?:niet (?:waar|juist|correct)|onjuist)|kan(?: helaas)? niet)\b/u.test(clause) ||
    /^je hebt (?:helemaal )?geen gelijk\b/u.test(clause) ||
    /^ik ben het (?:daar )?niet (?:met je )?eens\b/u.test(clause);
  if (negative) return 'no';
  if (/^geen probleem\b/u.test(clause)) return 'yes';
  // Negation not covered above is ambiguous: abstain rather than nod incorrectly.
  if (/\b(?:niet|geen|nooit|noch)\b/u.test(clause)) return null;
  if (/^(?:ja|jazeker|jawel|inderdaad|absoluut|zeker|precies|correct|klopt|yes)\b/u.test(clause) ||
      /^(?:(?:dat|dit) klopt|dat is (?:waar|juist|correct)|je hebt (?:helemaal )?gelijk|ik ben het (?:daar )?(?:met je )?eens)\b/u.test(clause)) return 'yes';
  return null;
}

export function expressionGesture(text, complete = false) {
  const raw = String(text).trim();
  if (/^["'“‘«>]/u.test(raw) || (!complete && !/[,.;!?\n]/.test(raw))) return null;
  const clause = raw.split(/[,.;!?\n]/)[0].toLowerCase();
  if (/\b(?:niet|geen|nooit|misschien|waarschijnlijk)\b/.test(clause)) return null;
  if (/^(?:wat leuk|wat fijn|geweldig|fantastisch|hoera|leuk idee)\b/.test(clause)) return 'happy';
  if (/^(?:wat vind jij|wat denk jij|hoe kijk jij|vertel eens|ben je benieuwd)\b/.test(clause)) return 'curious';
  return null;
}

export class AnswerGestureCue {
  constructor(emit = () => {}) { this.emit = emit; this.reset(); }
  reset() {
    this.responses = new Map();
    this.expired = new Set();
    this.active = null;
    this.level = 0;
  }
  expire(id) {
    if (!id) return;
    this.responses.delete(id);
    this.expired.add(id);
    while (this.expired.size > 32) this.expired.delete(this.expired.values().next().value);
    if (this.active === id) { this.active = null; this.level = 0; }
  }
  entry(id) {
    if (!id || this.expired.has(id)) return null;
    if (!this.responses.has(id)) {
      this.responses.set(id, { text: '', gesture: null, emitted: false });
      while (this.responses.size > 4) this.expire(this.responses.keys().next().value);
    }
    return this.responses.get(id);
  }
  flush() {
    const entry = this.responses.get(this.active);
    if (!entry?.gesture || entry.emitted || this.level < 0.02) return;
    entry.emitted = true;
    this.emit(entry.gesture);
  }
  setLevel(level) { this.level = level; this.flush(); }
  handleEvent(event) {
    const id = event.response_id || event.response?.id;
    if (event.type === 'response.created') {
      this.entry(id);
    } else if (event.type === 'response.output_audio_transcript.delta' || event.type === 'response.output_audio_transcript.done') {
      const entry = this.entry(id);
      if (!entry || entry.emitted) return;
      const done = event.type.endsWith('.done');
      entry.text = (done ? event.transcript || entry.text : entry.text + (event.delta || '')).slice(0, 512);
      entry.gesture = answerGesture(entry.text, done) || expressionGesture(entry.text, done);
      this.flush();
    } else if (event.type === 'output_audio_buffer.started') {
      if (!this.entry(id)) return;
      this.active = id;
      this.level = 0; // Wait for the first actually played audio, not just generated text.
    } else if (event.type === 'input_audio_buffer.speech_started') {
      // A cancelled transcript.done can arrive late. Tombstone every pending response.
      for (const pending of [...this.responses.keys()]) this.expire(pending);
    } else if (event.type === 'output_audio_buffer.stopped' || event.type === 'output_audio_buffer.cleared' ||
        (event.type === 'response.done' && ['cancelled', 'failed', 'incomplete'].includes(event.response?.status))) {
      this.expire(id);
    }
  }
}
