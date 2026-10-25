import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CompanionStore, STORAGE_KEY, cleanPreferences, companionInstructions, morningPrompt, memoryHandlers } from './companion.mjs';
import { WakeWord, wakeMatch } from './wake.mjs';
import { preparePhoto } from './photo.mjs';
import { SearchTools } from './search-tools.mjs';
import { ConversationMotion } from './motion.mjs';
import { expressionGesture, answerGesture, AnswerGestureCue } from './gestures.mjs';

function storageFixture() {
  const data = new Map();
  return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), data };
}

test('name, audio, movement, personality and explicit memories survive a new browser session', () => {
  const storage = storageFixture(), store = new CompanionStore(storage, () => 'id1');
  store.update({ duckName: 'Pippin', userName: 'Michael', interests: 'natuur', place: 'Utrecht', personality: 'speels', mode: 'natuur', pitch: 7, volume: 0.4, strength: 2, head: false, body: true });
  store.remember('Ik houd van vogels');
  const next = new CompanionStore(storage);
  assert.deepEqual(next.preferences, store.preferences); assert.deepEqual(next.memories, store.memories);
  assert.equal(storage.data.size, 1); assert.ok(storage.data.has(STORAGE_KEY));
  next.forget('id1'); assert.equal(new CompanionStore(storage).memories.length, 0);
});

test('corrupt or malicious preferences fall back, values clamp and unknown fields including keys are never saved', () => {
  const storage = storageFixture(); storage.setItem(STORAGE_KEY, '{broken');
  const store = new CompanionStore(storage);
  assert.match(store.loadError, /niet worden gelezen/);
  store.update({ duckName: '  Pip\n ', pitch: 100, volume: -1, strength: Infinity, personality: 'unsafe', OPENAI_API_KEY: 'private' });
  assert.equal(store.preferences.duckName, 'Pip'); assert.equal(store.preferences.pitch, 9);
  assert.equal(store.preferences.volume, 0); assert.equal(store.preferences.strength, 3);
  assert.ok(!storage.getItem(STORAGE_KEY).includes('private'));
  assert.equal(cleanPreferences(null).duckName, 'Duck');
});

test('failed storage must not pretend that a preference or memory was saved', () => {
  const store = new CompanionStore({ getItem: () => null, setItem() { throw new Error('quota'); } }, () => 'id');
  assert.throws(() => store.remember('vogels'), /Bewaren lukt niet/);
  assert.equal(store.memories.length, 0);
  assert.throws(() => store.update({ duckName: 'Pip' }), /Bewaren lukt niet/);
  assert.equal(store.preferences.duckName, 'Duck');
});

test('only explicit memory requests write, duplicates are bounded, disabled memory and common secret keys are rejected', () => {
  let id = 0;
  const store = new CompanionStore(storageFixture(), () => `id${++id}`);
  const handlers = memoryHandlers(store);
  assert.throws(() => handlers.remember_fact({ fact: 'vogels' }), /uitdrukkelijk/);
  assert.throws(() => handlers.remember_fact({ fact: 'mijn wachtwoord is geheim', explicit_request: true }), /geheime/);
  handlers.remember_fact({ fact: 'Ik houd van vogels', explicit_request: true });
  handlers.remember_fact({ fact: 'ik houd van vogels', explicit_request: true });
  assert.equal(store.memories.length, 1);
  for (let n = 1; n < 30; n++) store.remember(`feit ${n}`);
  assert.throws(() => store.remember('vol'), /vol/);
  store.update({ memoryEnabled: false });
  assert.throws(() => store.remember('geen opslag'), /staat uit/);
  assert.equal(handlers.list_memories().memories.length, 0);
  const prompt = companionInstructions(store.preferences, store.memories);
  assert.ok(!prompt.includes('Ik houd van vogels')); assert.match(prompt, /geen opdrachten/);
  store.clear(); assert.equal(store.memories.length, 0);
});

test('morning briefing asks for a missing place and uses saved interests and a place without inventing live weather', () => {
  const date = new Date(2026, 9, 25);
  assert.match(morningPrompt({}, date), /Vraag eerst voor welke plaats/);
  assert.match(morningPrompt({ place: 'Amsterdam' }, date), /Amsterdam/);
  assert.match(morningPrompt({ place: 'Amsterdam' }, date), /als Google beschikbaar/);
  const prompt = companionInstructions({ duckName: 'Pip', userName: 'Michael', personality: 'rustig', interests: 'vogels', mode: 'natuur' }, []);
  assert.match(prompt, /natuurmaatje/); assert.match(prompt, /Michael/); assert.match(prompt, /Spreek rustig/);
});

test('wake phrase respects word boundaries, accents and custom names and preserves the following question', () => {
  assert.deepEqual(wakeMatch('Hé Duck, wie was Obama?'), { remainder: 'wie was obama' });
  assert.deepEqual(wakeMatch('Hey Pippin', 'Pippin'), { remainder: '' });
  assert.deepEqual(wakeMatch('Hoi kleine Pip wat is dit', 'Kleine Pip'), { remainder: 'wat is dit' });
  assert.equal(wakeMatch('Duck, vertel iets'), null);
  assert.equal(wakeMatch('hé duckling'), null);
  assert.equal(wakeMatch('hé andere duck'), null);
});

function wakeFixture() {
  const recognitions = [], events = [], states = [], timers = new Map(); let n = 0;
  const wake = new WakeWord({ makeRecognition: () => {
    const r = { start() { this.started = true; }, abort() { this.aborted = true; } }; recognitions.push(r); return r;
  }, onWake: event => events.push(event), onState: state => states.push(state),
  schedule: fn => { timers.set(++n, fn); return n; }, unschedule: id => timers.delete(id) });
  return { wake, recognitions, events, states, timers };
}
function heard(r, text, isFinal = true) { r.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal }] }); }

test('wake listening is opt-in, starts a conversation once and ignores stale recognition callbacks', () => {
  const f = wakeFixture(); assert.equal(f.recognitions.length, 0);
  f.wake.enable(); const r = f.recognitions[0], stale = r.onresult;
  assert.equal(r.lang, 'nl-NL'); heard(r, 'Hé Duck', false); assert.equal(f.events.length, 0);
  heard(r, 'Hé Duck hoe werkt een motor'); assert.equal(r.aborted, true); assert.equal(f.events.length, 1);
  stale({ resultIndex: 0, results: [{ 0: { transcript: 'Hé Duck' }, isFinal: true }] });
  assert.equal(f.events.length, 1);
  f.wake.resume(); assert.equal(f.recognitions.length, 2);
  f.wake.disable(); assert.ok(f.recognitions[1].aborted); assert.equal(f.wake.enabled, false);
});

test('wake retries ordinary end, cancels restart timers on Stop and never retries permission or network errors', () => {
  const f = wakeFixture(); f.wake.enable(); f.recognitions[0].onend();
  assert.equal(f.timers.size, 1); f.wake.disable(); assert.equal(f.timers.size, 0);
  for (const error of ['not-allowed', 'network']) {
    f.wake.enable(); f.recognitions.at(-1).onerror({ error });
    assert.equal(f.wake.enabled, false); assert.equal(f.timers.size, 0); assert.match(f.states.at(-1), new RegExp(error));
  }
  const unavailable = new WakeWord({ makeRecognition() { throw new Error('niet ondersteund'); }, onState: text => f.states.push(text) });
  unavailable.enable(); assert.equal(unavailable.enabled, false); assert.equal(f.states.at(-1), 'niet ondersteund');
});

test('photo input is explicit, resized, bounded for the data channel and releases its bitmap', async () => {
  let closed = false;
  const bitmap = { width: 1000, height: 500, close() { closed = true; } };
  const canvas = { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA' };
  const image = await preparePhoto({ type: 'image/jpeg', size: 1234 }, { decode: async () => bitmap, makeCanvas: () => canvas });
  assert.equal(image, 'data:image/jpeg;base64,AAAA'); assert.equal(canvas.width, 384); assert.equal(canvas.height, 192); assert.ok(closed);
  await assert.rejects(preparePhoto({ type: 'text/html', size: 10 }), /Kies een/);
  await assert.rejects(preparePhoto({ type: 'image/png', size: 9 * 1024 * 1024 }), /maximaal/);
  closed = false; canvas.toDataURL = () => 'x'.repeat(50000);
  await assert.rejects(preparePhoto({ type: 'image/png', size: 100 }, { decode: async () => bitmap, makeCanvas: () => canvas }), /blijft te groot/);
  assert.ok(closed);
});

test('memory tools use completed Realtime calls and continue with a spoken confirmation after successful persistence', async () => {
  const store = new CompanionStore(storageFixture(), () => 'id1'), sent = [];
  const bridge = new SearchTools({ send: event => sent.push(event), extraTools: memoryHandlers(store) });
  bridge.handleEvent({ type: 'response.done', response: { id: 'r', status: 'completed', output: [{ type: 'function_call', name: 'remember_fact', call_id: 'c', arguments: JSON.stringify({ fact: 'Ik houd van vogels', explicit_request: true }) }] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.memories[0].fact, 'Ik houd van vogels');
  assert.equal(JSON.parse(sent[0].item.output).ok, true); assert.equal(sent[1].type, 'response.create');
});

test('enthusiasm and curious followups have separate cues while yes/no retains priority and every pose remains bounded', () => {
  assert.equal(expressionGesture('Wat leuk!', true), 'happy');
  assert.equal(expressionGesture('Wat vind jij daarvan?', true), 'curious');
  assert.equal(expressionGesture('Wat leuk is dit niet.', true), null);
  assert.equal(answerGesture('Ja, wat leuk!', true), 'yes');
  const emitted = [], cue = new AnswerGestureCue(kind => emitted.push(kind));
  cue.handleEvent({ type: 'response.output_audio_transcript.done', response_id: 'r', transcript: 'Geweldig!' });
  cue.handleEvent({ type: 'output_audio_buffer.started', response_id: 'r' }); cue.setLevel(0.5);
  assert.deepEqual(emitted, ['happy']);
  for (const kind of ['happy', 'curious']) {
    const motion = new ConversationMotion(); motion.setPhase('speaking'); motion.triggerGesture(kind);
    for (let n = 0; n < 100; n++) {
      motion.step(0.02, true);
      assert.ok(motion.head.every((v, i) => Math.abs(v) <= (i === 0 ? 0.12 : 0.30)));
      assert.ok(motion.body.every((v, i) => Math.abs(v) <= (i === 0 ? 0.008 : 0.10)));
    }
    motion.triggerGesture(kind); motion.step(0.02, false); assert.equal(motion.gesture, null);
  }
});

test('memory and Google can both finish in one turn with only one answer continuation', async () => {
  const store = new CompanionStore(storageFixture(), () => 'id'), sent = []; let lookups = 0;
  const bridge = new SearchTools({ send: e => sent.push(e), extraTools: memoryHandlers(store), search: async () => { lookups++; return { text: 'feiten', sources: [] }; } });
  bridge.handleEvent({ type: 'response.done', response: { id: 'r', status: 'completed', output: [
    { type: 'function_call', name: 'remember_fact', call_id: 'memory', arguments: '{"fact":"vogels","explicit_request":true}' },
    { type: 'function_call', name: 'search_web', call_id: 'search', arguments: '{"query":"Hoe vliegen vogels?"}' },
  ] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.memories.length, 1); assert.equal(lookups, 1);
  assert.equal(sent.filter(x => x.type === 'response.create').length, 1);
  assert.equal(sent.filter(x => x.type === 'conversation.item.create').length, 2);
});

test('mother voice migration removes the old high pitch once, preserving names, memories and other settings', () => {
  const storage = storageFixture();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, preferences: {
    duckName: 'Pippin', userName: 'Michael', place: 'Utrecht', pitch: 7, volume: 0.4, strength: 2, personality: 'speels',
  }, memories: [{ id: 'm', fact: 'Ik houd van vogels' }] }));
  const migrated = new CompanionStore(storage);
  assert.equal(migrated.preferences.pitch, 0); assert.equal(migrated.preferences.personality, 'moedereend');
  assert.equal(migrated.preferences.duckName, 'Pippin'); assert.equal(migrated.preferences.place, 'Utrecht');
  assert.equal(migrated.preferences.volume, 0.4); assert.equal(migrated.preferences.strength, 2);
  assert.equal(migrated.memories[0].fact, 'Ik houd van vogels'); assert.ok(migrated.loadNotice);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).preferences.voiceProfile, 'mother-v1');
  assert.equal(new CompanionStore(storage).loadNotice, '');
  migrated.update({ pitch: 2, personality: 'rustig' });
  const reloaded = new CompanionStore(storage);
  assert.equal(reloaded.preferences.pitch, 2); assert.equal(reloaded.preferences.personality, 'rustig');
  assert.equal(reloaded.loadNotice, ''); assert.equal(reloaded.memories.length, 1);
});

test('mother profile keeps homework mode and includes level-aware hints, examples and uncertainty without losing personal context', () => {
  const p = cleanPreferences({ mode: 'huiswerk', duckName: 'Pip' });
  assert.equal(p.personality, 'moedereend'); assert.equal(p.pitch, 0); assert.equal(p.mode, 'huiswerk');
  const prompt = companionInstructions(p, [{ id: 'm', fact: 'Ik houd van vogels' }]);
  assert.match(prompt, /moeder-eend/); assert.match(prompt, /schoolniveau/); assert.match(prompt, /hint/);
  assert.match(prompt, /uitgewerkt voorbeeld/); assert.match(prompt, /Controleer berekeningen/);
  assert.match(prompt, /onleesbaar/); assert.match(prompt, /Ik houd van vogels/);
});

test('wake restart and cancellation preserve the Window timer receiver too', t => {
  const timers = new Map(); let id = 0, recognition;
  t.mock.method(globalThis, 'setTimeout', function(callback) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    timers.set(++id, callback); return id;
  });
  t.mock.method(globalThis, 'clearTimeout', function(timer) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    timers.delete(timer);
  });
  const wake = new WakeWord({ makeRecognition: () => (recognition = { start() {}, abort() {} }) });
  wake.enable(); recognition.onend(); assert.equal(timers.size, 1);
  wake.disable(); assert.equal(timers.size, 0);
});
