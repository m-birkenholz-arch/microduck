import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createConversationServer, profile } from './server.mjs';
import { DuckPitchShifter } from './voice-worklet.mjs';
import { createDuckVoice } from './voice.mjs';
import { DuckConversation } from './client.mjs';
import { install } from './install.mjs';
import { ConversationMotion, headExpression } from './motion.mjs';
import { answerGesture, AnswerGestureCue } from './gestures.mjs';

const originalHead = 'for (let h = 0; h < 4; h++) headSmooth[h] += HEAD_ALPHA * (headTarget[h] - headSmooth[h]);';
const originalGame = `function buildObs() { ${originalHead} }\nfunction jawOpenNow() { return Math.min(1, pickJawNow() + Math.max(flap, padJaw)); }\nfunction activeSession() { if (recovery?.state === "recovering") return sessions.stand; return sessions[loco === "rollers" && mode === "walk" ? "drive" : mode]; }`;

const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const origin = 'http://localhost:5173';
async function withServer(t, options) {
  const server = createConversationServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (route, init = {}) => fetch(url + route, {
    ...init, headers: { Origin: origin, 'Content-Type': 'application/sdp', ...init.headers },
  });
  request.url = url;
  return request;
}

test('profile preserves the robot Dutch instructions, model, voice and VAD', async () => {
  const rust = await readFile(new URL('../src/main.rs', import.meta.url), 'utf8');
  const block = rust.split('"instructions": concat!(')[1].split('),')[0];
  const instructions = [...block.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(x => JSON.parse(x[0])).join('');
  assert.equal(profile.instructions, instructions);
  assert.ok(rust.includes(`const DEFAULT_MODEL: &str = "${profile.model}"`));
  assert.equal(profile.audio.output.voice, 'marin');
  assert.ok(rust.includes(`"voice": "${profile.audio.output.voice}"`));
  assert.equal(profile.audio.input.turn_detection.interrupt_response, true);
  assert.equal(profile.audio.input.turn_detection.create_response, true);
  assert.equal(profile.audio.input.turn_detection.silence_duration_ms, 450);
  assert.equal(profile.audio.input.format, undefined); // Negotiated by WebRTC.
});

test('SDP exchange uses the server key and returns only the audio answer', async t => {
  const request = await withServer(t, { apiKey: 'local-secret', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal(init.headers.Authorization, 'Bearer local-secret');
    assert.equal(init.body.get('sdp'), offer);
    assert.deepEqual(JSON.parse(init.body.get('session')), profile);
    return new Response('v=0\r\nanswer');
  } });
  const response = await request('/session', { method: 'POST', body: offer });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(await response.text(), 'v=0\r\nanswer');
  const health = await (await request('/health')).text();
  assert.ok(!health.includes('local-secret'));
});

test('hostile origins, rebinding hosts and malformed audio cannot start paid sessions', async t => {
  let calls = 0;
  const request = await withServer(t, { apiKey: 'secret', fetchImpl: async () => { calls++; } });
  assert.equal((await request('/session', { method: 'POST', body: offer, headers: { Origin: 'https://example.org' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const raw = httpRequest(request.url + '/session', { method: 'POST', headers: {
      Host: 'attacker.example', Origin: origin, 'Content-Type': 'application/sdp',
    } }, response => { response.resume(); resolve(response.statusCode); });
    raw.on('error', reject);
    raw.end(offer);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await request('/session', { method: 'POST', body: 'bad' })).status, 400);
  assert.equal((await request('/session', { method: 'POST', body: offer, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/session', { method: 'POST', body: 'v=0\nm=audio' + 'x'.repeat(131072) })).status, 413);
  assert.equal(calls, 0);
});

test('upstream failures give useful local messages without forwarding credentials', async t => {
  const request = await withServer(t, { apiKey: 'local-secret', fetchImpl: async () => new Response('echo local-secret', { status: 429 }) });
  const response = await request('/session', { method: 'POST', body: offer });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /API-tegoed/);
  assert.ok(!text.includes('local-secret'));
});

test('missing API key fails before contacting OpenAI', async t => {
  const request = await withServer(t, { apiKey: '', fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal((await request('/session', { method: 'POST', body: offer })).status, 503);
});

test('installer is repeatable, preserves the original files and connects the jaw', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'app/src/game'), { recursive: true });
  const index = '<body>simulator</body>';
  const game = originalGame;
  await writeFile(path.join(root, 'app/index.html'), index);
  await writeFile(path.join(root, 'app/src/game/game.js'), game);
  await install(root);
  const first = await readFile(path.join(root, 'app/src/game/game.js'), 'utf8');
  await install(root);
  assert.equal(await readFile(path.join(root, 'app/src/game/game.js'), 'utf8'), first);
  assert.ok(first.includes('getConversationJaw()'));
  assert.ok(first.includes('stepConversationHead(CTRL_DT,'));
  assert.equal(await readFile(path.join(root, 'app/index.html.before-conversation'), 'utf8'), index);
  assert.equal(await readFile(path.join(root, 'app/src/game/game.js.before-conversation'), 'utf8'), game);
  assert.equal((await readFile(path.join(root, 'app/index.html'), 'utf8')).split('/src/duck-conversation/panel.mjs').length, 2);
});

test('upgrading a jaw-only install preserves manual head targets and yields to other movement', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'app/src/game'), { recursive: true });
  await writeFile(path.join(root, 'app/index.html'), '<body><script type="module" src="/src/duck-conversation/panel.mjs"></script></body>');
  await writeFile(path.join(root, 'app/src/game/game.js'),
    'import { getConversationJaw } from "../duck-conversation/mouth.mjs";\n' +
    originalGame.replace('Math.max(flap, padJaw)', 'Math.max(flap, padJaw, getConversationJaw())'));
  await install(root);
  const patched = (await readFile(path.join(root, 'app/src/game/game.js'), 'utf8')).replace(/^import .*;\n/gm, '');
  const context = {
    CTRL_DT: 0.02, HEAD_ALPHA: 0.2, inputLocked: false, mode: 'walk', loco: 'legs',
    headMode: false, recovery: null, grab: null, scriptRun: null, customPolicy: null,
    postKickLock: 0, standTimer: null, cmd: new Float32Array(13),
    effectiveCmd: () => context.cmd,
    getConversationBody: () => [0.004, 0.02, -0.03],
    useConversationStand: allowed => allowed,
    sessions: { walk: 'walking', stand: 'standing', drive: 'driving' },
    headTarget: [0.3, -0.1, 0.2, 0.1], headSmooth: [0, 0, 0, 0],
    stepConversationHead: (dt, allowed) => allowed ? [0.01, -0.04, 0.03, 0.02] : [0, 0, 0, 0],
  };
  vm.createContext(context);
  vm.runInContext(patched, context);
  context.buildObs();
  assert.ok(Math.abs(context.headSmooth[0] - 0.2 * 0.31) < 1e-10);
  assert.deepEqual(context.headTarget, [0.3, -0.1, 0.2, 0.1]);
  assert.equal(context.activeSession(), 'standing');
  assert.ok(Math.abs(context.cmd[9] - 0.004) < 1e-8);
  assert.ok(Math.abs(context.cmd[10] - 0.02) < 1e-8);
  assert.ok(Math.abs(context.cmd[11] + 0.03) < 1e-8);
  for (const slot of [7, 8, 12]) assert.equal(context.cmd[slot], 0);
  for (const override of [
    { inputLocked: true }, { mode: 'groundpick' }, { mode: 'sitstand' }, { mode: 'kickL' },
    { mode: 'roll' }, { loco: 'rollers' }, { headMode: true }, { recovery: {} },
    { grab: {} }, { scriptRun: {} }, { customPolicy: {} }, { postKickLock: 1 },
    { standTimer: {} }, { cmd: [0.1, 0, 0] },
  ]) {
    const before = Object.fromEntries(Object.keys(override).map(key => [key, context[key]]));
    Object.assign(context, override);
    context.headSmooth = [0, 0, 0, 0];
    context.buildObs();
    for (let h = 0; h < 4; h++) assert.equal(context.headSmooth[h], 0.2 * context.headTarget[h]);
    for (const slot of [7, 8, 9, 10, 11, 12]) assert.equal(context.cmd[slot] || 0, 0);
    if (override.recovery) {
      context.recovery = { state: 'recovering' };
      assert.equal(context.activeSession(), 'standing', 'fall recovery retains its standing network');
    } else if (!override.mode) {
      assert.notEqual(context.activeSession(), 'standing', 'manual movement must release conversation standing');
    }
    Object.assign(context, before);
  }
});

test('unknown head code prevents even the jaw/index edits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-head-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'app/src/game'), { recursive: true });
  const index = '<body>untouched</body>';
  const game = originalGame.replace(originalHead, '// unknown head implementation');
  await writeFile(path.join(root, 'app/index.html'), index);
  await writeFile(path.join(root, 'app/src/game/game.js'), game);
  await assert.rejects(install(root), /Hoofdsturing wijkt af/);
  assert.equal(await readFile(path.join(root, 'app/index.html'), 'utf8'), index);
  assert.equal(await readFile(path.join(root, 'app/src/game/game.js'), 'utf8'), game);
});

test('conversation phases follow actual input/output audio and interruption', async () => {
  const phases = [];
  const f = browserFixture({ onPhase: phase => phases.push(phase) });
  await f.duck.start();
  f.channel.onopen();
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_started' });
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_stopped' });
  f.duck.handleEvent({ type: 'output_audio_buffer.started' });
  // response.done can precede completion of buffered audio: it must not stop motion.
  f.duck.handleEvent({ type: 'response.done' });
  assert.equal(phases.at(-1), 'speaking');
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(phases.at(-1), 'listening');
  f.duck.stop();
  assert.deepEqual(phases, ['off', 'connecting', 'listening', 'listening', 'thinking', 'speaking', 'listening', 'off']);
});

test('speaking reuses the existing chorale head-expression pattern', async () => {
  const rust = await readFile(new URL('../../robotd/src/chorale.rs', import.meta.url), 'utf8');
  const values = Object.fromEntries([...rust.matchAll(/const (SWAY_ROLL|DRIFT_YAW|REACH_LIFT|BOB_PITCH): f64 = (-?[\d.]+);/g)]
    .map(match => [match[1], Number(match[2])]));
  for (const beat of [0, 0.1, 1, 2.5, 7.1]) {
    const reach = 0.7;
    const expected = [0,
      values.REACH_LIFT * reach + values.BOB_PITCH * Math.sin(2 * Math.PI * beat),
      values.DRIFT_YAW * Math.sin(2 * Math.PI * beat / 8),
      values.SWAY_ROLL * Math.sin(2 * Math.PI * beat / 4)];
    assert.deepEqual(headExpression(beat, reach), expected);
  }
});

test('motion stays bounded, fades to neutral and does not queue reactions during manual control', () => {
  const motion = new ConversationMotion();
  assert.deepEqual(motion.step(0.02, true), [0, 0, 0, 0]);
  motion.setPhase('speaking');
  motion.setLevel(1);
  let last = [0, 0, 0, 0];
  let moved = false;
  for (let step = 0; step < 500; step++) {
    const head = [...motion.step(0.02, true)];
    for (let h = 0; h < 4; h++) {
      assert.ok(Math.abs(head[h]) <= (h === 0 ? 0.12 : 0.30));
      assert.ok(Math.abs(head[h] - last[h]) < 0.02);
    }
    moved ||= head.some(value => Math.abs(value) > 0.02);
    last = head;
  }
  assert.ok(moved);
  assert.deepEqual(motion.step(0.02, false), [0, 0, 0, 0]);
  assert.ok(motion.step(0.02, true).every(value => Math.abs(value) < 0.02));
  motion.setPhase('listening');
  for (let step = 0; step < 100; step++) motion.step(0.02, true);
  assert.ok(motion.head[3] > 0.02);
  motion.setPhase('off');
  for (let step = 0; step < 300; step++) motion.step(0.02, true);
  assert.deepEqual(motion.head, [0, 0, 0, 0]);
  motion.setPhase('speaking');
  motion.enabled = false;
  assert.deepEqual(motion.step(0.02, true), [0, 0, 0, 0]);
});

test('quiet speech has visible motion and strength can be adjusted within bounded offsets', () => {
  const peakAt = strength => {
    const motion = new ConversationMotion();
    motion.setStrength(strength);
    motion.setPhase('speaking');
    motion.setLevel(0.05); // Quiet laptop audio, rather than a full-scale test tone.
    let peak = 0;
    for (let step = 0; step < 600; step++) {
      const head = motion.step(0.02, true);
      peak = Math.max(peak, Math.abs(head[2]), Math.abs(head[3]));
      assert.ok(head.every(v => Number.isFinite(v) && Math.abs(v) <= 0.30));
    }
    return peak;
  };
  const quiet = peakAt(1);
  const clear = peakAt(3);
  assert.ok(clear > 0.10, 'at least about six degrees for quiet speech');
  assert.ok(clear > quiet * 2.9);
  assert.ok(peakAt(4) > clear);
  const motion = new ConversationMotion();
  motion.setStrength(100); assert.equal(motion.strength, 4);
  motion.setStrength(-1); assert.equal(motion.strength, 1);
  motion.setStrength(NaN); assert.equal(motion.strength, 3);
});

test('body sway uses bounded standing poses, fades before releasing standing, and yields immediately', () => {
  const motion = new ConversationMotion();
  assert.equal(motion.wantsStand(true), false);
  motion.setPhase('speaking');
  motion.setLevel(0.8);
  assert.equal(motion.wantsStand(true), true);
  const peak = [0, 0, 0];
  let previous = [0, 0, 0];
  for (let step = 0; step < 1000; step++) {
    motion.step(0.02, true);
    motion.body.forEach((value, axis) => {
      assert.ok(Math.abs(value) <= (axis === 0 ? 0.008 : 0.10));
      assert.ok(Math.abs(value - previous[axis]) < (axis === 0 ? 0.0006 : 0.01));
      peak[axis] = Math.max(peak[axis], Math.abs(value));
    });
    previous = [...motion.body];
  }
  assert.ok(peak[0] > 0.002 && peak[1] > 0.03 && peak[2] > 0.04);
  motion.setPhase('off');
  assert.equal(motion.wantsStand(true), true, 'keep standing through neutral return');
  for (let step = 0; step < 400; step++) motion.step(0.02, true);
  assert.deepEqual(motion.body, [0, 0, 0]);
  assert.equal(motion.wantsStand(true), false);
  motion.setPhase('speaking');
  motion.setLevel(1);
  for (let step = 0; step < 100; step++) motion.step(0.02, true);
  assert.equal(motion.wantsStand(false), false);
  motion.step(0.02, false);
  assert.deepEqual(motion.body, [0, 0, 0]);
  assert.deepEqual(motion.head, [0, 0, 0, 0]);
});

test('body and head toggles are independent', () => {
  const motion = new ConversationMotion();
  motion.setPhase('speaking');
  motion.setLevel(0.8);
  motion.enabled = false;
  for (let step = 0; step < 100; step++) motion.step(0.02, true);
  assert.deepEqual(motion.head, [0, 0, 0, 0]);
  assert.ok(motion.body.some(value => Math.abs(value) > 0.01));
  motion.enabled = true;
  motion.bodyEnabled = false;
  for (let step = 0; step < 400; step++) motion.step(0.02, true);
  assert.deepEqual(motion.body, [0, 0, 0]);
  assert.ok(motion.head.some(value => Math.abs(value) > 0.01));
  assert.equal(motion.wantsStand(true), false);
});

test('installer refuses unknown standing policy selection before editing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-policy-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'app/src/game'), { recursive: true });
  const index = '<body>untouched</body>';
  const game = originalGame.replace('if (recovery?.state === "recovering") return sessions.stand;', '// unknown session selector');
  await writeFile(path.join(root, 'app/index.html'), index);
  await writeFile(path.join(root, 'app/src/game/game.js'), game);
  await assert.rejects(install(root), /Policyselectie wijkt af/);
  assert.equal(await readFile(path.join(root, 'app/index.html'), 'utf8'), index);
  assert.equal(await readFile(path.join(root, 'app/src/game/game.js'), 'utf8'), game);
});

test('Dutch yes/no cues distinguish clear confirmations, negation, quotations and uncertainty', () => {
  for (const text of ['Ja, dat klopt.', 'Jazeker!', 'Inderdaad.', 'Dat klopt.', 'Je hebt gelijk.', 'Geen probleem.', 'Zeker weten.']) {
    assert.equal(answerGesture(text, true), 'yes', text);
  }
  for (const text of ['Nee, dat klopt niet.', 'Zeker niet.', 'Absoluut niet.', 'Dat klopt niet.', 'Dat is niet waar.', 'Ik ben het niet met je eens.']) {
    assert.equal(answerGesture(text, true), 'no', text);
  }
  for (const text of ['Misschien wel.', 'Dat weet ik niet zeker.', 'Obama was president.', 'Hij zei ja.', '"Ja", zei hij.', 'Ja?', 'Klopt het?', 'Ja noch nee.', 'Dat klopt mogelijk niet.']) {
    assert.equal(answerGesture(text, true), null, text);
  }
  assert.equal(answerGesture('Dat klopt '), null);
  assert.equal(answerGesture('Dat klopt niet.'), 'no');
  assert.equal(answerGesture('Ne'), null);
  assert.equal(answerGesture('Nee,'), 'no');
});

test('transcript cues wait for audible output and emit only once per response', () => {
  const emitted = [];
  const cue = new AnswerGestureCue(kind => emitted.push(kind));
  cue.handleEvent({ type: 'response.created', response: { id: 'r1' } });
  cue.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'Ja,' });
  cue.setLevel(0.8);
  assert.deepEqual(emitted, []); // The model can generate text before playback starts.
  cue.handleEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  cue.handleEvent({ type: 'output_audio_buffer.started', response_id: 'r1' });
  cue.setLevel(0);
  assert.deepEqual(emitted, []);
  cue.setLevel(0.1);
  assert.deepEqual(emitted, ['yes']);
  cue.handleEvent({ type: 'response.output_audio_transcript.done', response_id: 'r1', transcript: 'Ja, dat klopt.' });
  cue.setLevel(0.8);
  assert.deepEqual(emitted, ['yes']);
});

test('split transcript negation does not cause an early affirmative nod', () => {
  const emitted = [];
  const cue = new AnswerGestureCue(kind => emitted.push(kind));
  cue.handleEvent({ type: 'output_audio_buffer.started', response_id: 'r1' });
  cue.setLevel(0.5);
  cue.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'Dat klopt ' });
  assert.deepEqual(emitted, []);
  cue.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'niet.' });
  assert.deepEqual(emitted, ['no']);
});

test('barge-in and a drained buffer discard late transcript and pending gesture cues', () => {
  const emitted = [];
  const cue = new AnswerGestureCue(kind => emitted.push(kind));
  cue.handleEvent({ type: 'response.created', response: { id: 'old' } });
  cue.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'old', delta: 'Ja,' });
  cue.handleEvent({ type: 'input_audio_buffer.speech_started' });
  cue.handleEvent({ type: 'response.output_audio_transcript.done', response_id: 'old', transcript: 'Ja, dat klopt.' });
  cue.handleEvent({ type: 'output_audio_buffer.started', response_id: 'old' });
  cue.setLevel(1);
  assert.deepEqual(emitted, []);
  cue.handleEvent({ type: 'output_audio_buffer.started', response_id: 'new' });
  cue.setLevel(0.5);
  cue.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'new', delta: 'Nee,' });
  assert.deepEqual(emitted, ['no']);
  cue.handleEvent({ type: 'output_audio_buffer.stopped', response_id: 'new' });
  cue.handleEvent({ type: 'response.output_audio_transcript.done', response_id: 'new', transcript: 'Nee, dat klopt niet.' });
  cue.setLevel(1);
  assert.deepEqual(emitted, ['no']);
});

test('client connects audio transcript cues to gesture callbacks and cancels on interruption', async () => {
  const gestures = [];
  const f = browserFixture({ onGesture: kind => gestures.push(kind) });
  await f.duck.start();
  f.duck.handleEvent({ type: 'response.created', response: { id: 'r1' } });
  f.duck.handleEvent({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'Ja,' });
  f.duck.handleEvent({ type: 'output_audio_buffer.started', response_id: 'r1' });
  f.duck.gestureCue.setLevel(0.4);
  assert.deepEqual(gestures, ['yes']);
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_started' });
  f.duck.handleEvent({ type: 'response.output_audio_transcript.done', response_id: 'r1', transcript: 'Ja, dat klopt.' });
  f.duck.gestureCue.setLevel(1);
  assert.deepEqual(gestures, ['yes']);
  f.duck.stop();
  assert.equal(f.duck.gestureCue.responses.size, 0);
});

test('yes nods in pitch, no shakes in yaw, both are bounded and preserve body motion', () => {
  for (const kind of ['yes', 'no']) {
    const motion = new ConversationMotion();
    const baseline = new ConversationMotion();
    for (const m of [motion, baseline]) { m.setPhase('speaking'); m.setLevel(0.7); }
    motion.triggerGesture(kind);
    let peak = 0;
    let previous = [0, 0, 0, 0];
    for (let step = 0; step < 80; step++) {
      const head = [...motion.step(0.02, true)];
      baseline.step(0.02, true);
      assert.deepEqual(motion.body, baseline.body);
      for (let h = 0; h < 4; h++) {
        assert.ok(Math.abs(head[h]) <= (h === 0 ? 0.12 : 0.30));
        assert.ok(Math.abs(head[h] - previous[h]) < 0.06);
      }
      const axis = kind === 'yes' ? 1 : 2;
      peak = Math.max(peak, Math.abs(head[axis]));
      assert.equal(head[kind === 'yes' ? 2 : 1], 0);
      assert.equal(head[3], 0);
      previous = head;
    }
    assert.ok(peak > 0.10);
    for (let step = 0; step < 20; step++) motion.step(0.02, true);
    assert.equal(motion.gesture, null);
  }
});

test('gestures stop on interruption, manual override, disabled head motion and Stop', () => {
  const motion = new ConversationMotion();
  motion.triggerGesture('yes');
  assert.equal(motion.gesture, null);
  motion.setPhase('speaking');
  motion.triggerGesture('yes');
  motion.step(0.02, true);
  motion.setPhase('listening');
  assert.equal(motion.gesture, null);
  motion.setPhase('speaking'); motion.triggerGesture('no');
  motion.step(0.02, false);
  assert.equal(motion.gesture, null);
  motion.step(0.02, true);
  assert.equal(motion.gesture, null); // No replay after releasing manual control.
  motion.triggerGesture('yes'); motion.enabled = false;
  motion.step(0.02, true);
  assert.equal(motion.gesture, null);
  motion.enabled = true; motion.triggerGesture('no'); motion.setPhase('off');
  assert.equal(motion.gesture, null);
});

test('installer refuses an unknown simulator version before editing files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'app/src/game'), { recursive: true });
  await writeFile(path.join(root, 'app/index.html'), '<body>untouched</body>');
  await writeFile(path.join(root, 'app/src/game/game.js'), '// unknown jaw implementation');
  await assert.rejects(install(root), /Snavelcode wijkt af/);
  assert.equal(await readFile(path.join(root, 'app/index.html'), 'utf8'), '<body>untouched</body>');
});

function browserFixture(extra = {}) {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = { readyState: 'open', messages: [], send(value) { this.messages.push(JSON.parse(value)); }, close() { this.closed = true; } };
  const peer = {
    addTrack() {}, createDataChannel: () => channel,
    createOffer: async () => ({ sdp: offer }), setLocalDescription: async () => {},
    setRemoteDescription: async () => {}, close() { this.closed = true; },
  };
  const audio = { muted: false, pause() {}, play: async () => {} };
  const node = () => ({ connections: [], connect(target) { this.connections.push(target); }, disconnect() { this.disconnected = true; } });
  const source = node();
  const analyser = { ...node(), fftSize: 256, getFloatTimeDomainData(samples) { samples.fill(0.1); } };
  const context = { resume: async () => {}, close: async () => {}, destination: {},
    createMediaStreamSource: () => source, createAnalyser: () => analyser };
  const voice = { input: node(), output: node(), muted: true,
    setMuted(value) { this.muted = value; }, setPitch(value) { this.pitch = value; }, close() { this.closed = true; } };
  const states = [];
  const duck = new DuckConversation({
    mediaDevices: { getUserMedia: async () => stream }, makePeer: () => peer,
    makeAudio: () => audio, makeContext: () => context, makeVoice: async () => voice,
    fetchImpl: async url => new Response(url.endsWith('/health') ? '{"ready":true}' : 'v=0\r\nanswer'),
    onStatus: (text, active) => states.push({ text, active }), ...extra,
  });
  return { duck, track, peer, channel, audio, states, stream, voice, source, analyser, context };
}

test('barge-in immediately mutes playback, the next answer unmutes it, Stop releases the mic', async () => {
  const f = browserFixture();
  await f.duck.start();
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(f.audio.muted, true);
  assert.equal(f.voice.muted, true);
  assert.equal(f.track.stopped, false); // Listening continues during interruption.
  f.duck.handleEvent({ type: 'output_audio_buffer.started' });
  assert.equal(f.audio.muted, false);
  assert.equal(f.voice.muted, false);
  f.duck.stop();
  assert.ok(f.track.stopped && f.peer.closed && f.channel.closed);
});

test('the default browser fetch keeps its Window receiver rather than the conversation instance', async t => {
  // Node fetch tolerates any receiver. Window.fetch rejects the old this.fetchImpl
  // call before sending a request, even when the loopback helper is running.
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async function(url) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    requests++;
    return new Response(url.endsWith('/health') ? '{"ready":true}' : 'v=0\r\nanswer');
  });
  const f = browserFixture({ fetchImpl: undefined });
  t.after(() => f.duck.stop());
  await f.duck.start();
  assert.equal(requests, 2);
  assert.equal(f.duck.peer, f.peer);
  assert.equal(f.track.stopped, false);
});

test('Stop while microphone permission is pending cannot leave a live microphone behind', async () => {
  let resolveMic;
  const f = browserFixture({ mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveMic = resolve; }) } });
  const starting = f.duck.start();
  while (!resolveMic) await new Promise(resolve => setTimeout(resolve, 0));
  f.duck.stop();
  resolveMic(f.stream);
  await starting;
  assert.ok(f.track.stopped);
  assert.equal(f.duck.peer, null);
});

test('failed SDP exchange releases audio capture and exposes the useful error', async () => {
  const f = browserFixture({ fetchImpl: async url => url.endsWith('/health')
    ? new Response('{"ready":true}') : new Response('Controleer API-tegoed', { status: 502 }) });
  await f.duck.start();
  assert.ok(f.track.stopped && f.peer.closed);
  assert.deepEqual(f.states.at(-1), { text: 'Controleer API-tegoed', active: false });
});


test('pitch shift raises the carrier without changing stream length at browser sample rates', () => {
  for (const rate of [24000, 44100, 48000]) {
    const shifter = new DuckPitchShifter(rate, 5);
    const input = Float32Array.from({ length: rate }, (_, n) => 0.5 * Math.sin(2 * Math.PI * 220 * n / rate));
    const output = new Float32Array(rate);
    for (let offset = 0; offset < rate; offset += 128) {
      shifter.process(input.subarray(offset, offset + 128), output.subarray(offset, offset + 128));
    }
    let best = 0, peak = 0;
    // Crossfade sidebands can move the peak a few Hz; detect the actual spectrum,
    // rather than just testing that the configured pitch number changed.
    for (let hz = 200; hz <= 350; hz++) {
      let re = 0, im = 0;
      for (let n = Math.floor(rate / 5); n < rate; n++) {
        re += output[n] * Math.cos(2 * Math.PI * hz * n / rate);
        im += output[n] * Math.sin(2 * Math.PI * hz * n / rate);
      }
      const power = re * re + im * im;
      if (power > best) { best = power; peak = hz; }
    }
    assert.ok(Math.abs(peak - 220 * 2 ** (5 / 12)) < 8, `rate ${rate}, measured peak ${peak}`);
    assert.ok(output.every(x => Number.isFinite(x) && Math.abs(x) <= 0.501));
    assert.ok(best > rate, 'audio is present');
    shifter.reset();
    const silence = new Float32Array(rate / 10);
    shifter.process(undefined, silence);
    assert.ok(silence.every(x => x === 0), 'interrupted audio cannot leak from the delay');
  }
});

test('zero pitch bypasses, extreme controls clamp and sustained DC does not amplify', () => {
  const shifter = new DuckPitchShifter(48000, 0);
  const input = Float32Array.from({ length: 10000 }, (_, n) => Math.sin(n));
  const output = new Float32Array(input.length);
  shifter.process(input, output);
  assert.deepEqual(output, input);
  shifter.setPitch(100); assert.equal(shifter.semitones, 9);
  shifter.setPitch(-10); assert.equal(shifter.semitones, 0);
  shifter.setPitch(NaN); assert.equal(shifter.semitones, 0);
  input.fill(0.5);
  shifter.process(input, output);
  assert.ok(output.slice(4000).every(x => Math.abs(x - 0.5) < 1e-6));
});

test('only processed audio reaches the speaker, live pitch control and barge-in keep working', async t => {
  const f = browserFixture();
  t.after(() => f.duck.stop());
  await f.duck.start();
  f.channel.onopen();
  assert.equal(f.channel.messages[0].session.audio.output.voice, profile.audio.output.voice);
  await f.peer.ontrack({ streams: [f.stream] });
  assert.equal(f.audio.volume, 0, 'raw adult voice must never play alongside the duck');
  assert.deepEqual(f.source.connections, [f.voice.input]);
  assert.deepEqual(f.voice.output.connections, [f.analyser]);
  assert.deepEqual(f.analyser.connections, [f.context.destination]);
  f.duck.setVoicePitch(7);
  assert.equal(f.voice.pitch, 7);
  f.duck.handleEvent({ type: 'output_audio_buffer.started' });
  assert.equal(f.voice.muted, false);
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(f.voice.muted, true);
  f.duck.handleEvent({ type: 'output_audio_buffer.started' });
  f.duck.handleEvent({ type: 'output_audio_buffer.cleared' });
  assert.equal(f.voice.muted, true);
  f.duck.stop();
  assert.ok(f.voice.closed && f.source.disconnected && f.analyser.disconnected);
});

test('worklet output gate mutes immediately, clears old speech and closes resources', async t => {
  const messages = [];
  let worklet;
  const previous = globalThis.AudioWorkletNode;
  t.after(() => { if (previous) globalThis.AudioWorkletNode = previous; else delete globalThis.AudioWorkletNode; });
  globalThis.AudioWorkletNode = class {
    constructor(context, name, options) {
      worklet = this; this.options = options;
      this.port = { postMessage: message => messages.push(message), close: () => { this.closed = true; } };
    }
    connect() {} disconnect() { this.disconnected = true; }
  };
  const changes = [];
  const gain = { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime: value => changes.push(value) }, disconnect() {} };
  const context = { currentTime: 1, audioWorklet: { addModule: async url => assert.ok(url.pathname.endsWith('voice-worklet.mjs')) }, createGain: () => gain };
  const voice = await createDuckVoice(context, 6);
  assert.equal(gain.gain.value, 0);
  assert.equal(worklet.options.processorOptions.semitones, 6);
  voice.setMuted(false); voice.setMuted(true); voice.setPitch(8);
  assert.deepEqual(changes, [1, 0]);
  assert.deepEqual(messages, [{ type: 'reset' }, { type: 'pitch', value: 8 }]);
  voice.setVolume(0.25); assert.equal(changes.at(-1), 0, 'volume changes cannot unmute an interrupted answer');
  voice.setMuted(false); assert.equal(changes.at(-1), 0.25);
  voice.setVolume(2); assert.equal(changes.at(-1), 1, 'volume remains bounded');
  voice.close();
  assert.ok(worklet.closed && worklet.disconnected);
});


test('registered audio processor processes missing input safely and accepts reset and pitch messages', async () => {
  let Processor;
  const scope = {
    Float32Array, Math, Number, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    registerProcessor(name, value) { assert.equal(name, 'duck-voice'); Processor = value; },
  };
  const source = await readFile(new URL('./voice-worklet.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source.replace('export class', 'class'), scope);
  const processor = new Processor({ processorOptions: { semitones: 0 } });
  const input = new Float32Array(128).fill(0.2);
  const output = new Float32Array(128);
  assert.equal(processor.process([[input]], [[output]]), true);
  assert.deepEqual(output, input);
  processor.port.onmessage({ data: { type: 'pitch', value: 7 } });
  assert.equal(processor.shifter.semitones, 7);
  processor.port.onmessage({ data: { type: 'reset' } });
  processor.process([], [[output]]);
  assert.ok(output.every(x => x === 0));
});

test('browser completes a Google lookup on the data channel and displays the returned evidence', async t => {
  const results = [], ready = [];
  const f = browserFixture({
    onSearchReady: value => ready.push(value), onSearchResult: value => results.push(value),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/health')) return Response.json({ ready: true, googleSearch: true });
      if (url.endsWith('/search')) {
        assert.deepEqual(JSON.parse(init.body), { query: 'Wie was Obama?' });
        assert.ok(init.signal);
        return Response.json({ provider: 'Google Search', text: '44e president', sources: [{ title: 'Library', url: 'https://www.obamalibrary.gov/' }] });
      }
      return new Response('v=0\r\nanswer');
    },
  });
  t.after(() => f.duck.stop());
  await f.duck.start();
  f.channel.onopen();
  f.channel.onmessage({ data: JSON.stringify({ type: 'response.done', response: {
    id: 'search1', status: 'completed', output: [{ type: 'function_call', name: 'search_web', call_id: 'google1', arguments: '{"query":"Wie was Obama?"}' }],
  } }) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(ready, [true]);
  assert.equal(results.at(-1).text, '44e president');
  const output = f.channel.messages.find(x => x.type === 'conversation.item.create');
  assert.equal(output.item.call_id, 'google1');
  assert.equal(JSON.parse(output.item.output).ok, true);
  assert.equal(f.channel.messages.at(-1).type, 'response.create');
  assert.ok(f.states.some(x => x.text.includes('Google')));
});

test('personalized startup keeps Google tools, adds explicit memory tools and starts a requested morning message', async t => {
  const companionStore = { preferences: { duckName: 'Pip', userName: 'Michael', memoryEnabled: true, pitch: 7, volume: 0.4 }, memories: [{ id: 'm1', fact: 'Ik houd van vogels' }] };
  const f = browserFixture({ companionStore, fetchImpl: async url => url.endsWith('/health')
    ? Response.json({ ready: true, companionVersion: 1, instructions: profile.instructions, tools: [{ type: 'function', name: 'search_web' }] })
    : new Response('v=0\r\nanswer') });
  t.after(() => f.duck.stop());
  await f.duck.start({ initialText: 'Goedemorgen, vertel het weer.' });
  f.channel.onopen();
  const session = f.channel.messages[0].session;
  assert.match(session.instructions, /Michael/); assert.match(session.instructions, /Ik houd van vogels/);
  assert.ok(session.tools.some(x => x.name === 'remember_fact'));
  assert.ok(session.tools.some(x => x.name === 'search_web'));
  assert.equal(f.duck.voicePitch, 7); assert.equal(f.duck.volume, 0.4);
  assert.equal(f.channel.messages[1].item.content[0].text, 'Goedemorgen, vertel het weer.');
  companionStore.preferences.memoryEnabled = false;
  f.duck.updatePersonalization();
  const changed = f.channel.messages.at(-1).session;
  assert.ok(!changed.instructions.includes('Ik houd van vogels'));
  assert.ok(!changed.tools.some(x => x.name === 'remember_fact'));
  assert.ok(changed.tools.some(x => x.name === 'search_web'));
});

test('personalization detects an outdated helper before opening the microphone', async () => {
  const f = browserFixture({ companionStore: { preferences: {}, memories: [] } });
  await f.duck.start();
  assert.match(f.states.at(-1).text, /Werk de gesprekshulp bij/);
  assert.equal(f.duck.peer, null); assert.equal(f.duck.stream, null);
});

test('a prepared wake context is reused, Stop closes a late unlock, and photos use input_image only on explicit request', async t => {
  const f = browserFixture(); t.after(() => f.duck.stop());
  await f.duck.primeAudio(); assert.equal(f.duck.primedContext, f.context);
  await f.duck.start(); assert.equal(f.duck.context, f.context); assert.equal(f.duck.primedContext, null);
  f.duck.ask('Wat zie je?', 'data:image/jpeg;base64,AAAA');
  assert.equal(f.channel.messages[0].item.content[1].type, 'input_image');
  assert.throws(() => f.duck.ask('x', 'https://private.example/photo'), /Foto te groot/);
  assert.throws(() => f.duck.ask('x', 'data:image/jpeg;base64,' + 'A'.repeat(50000)), /Foto te groot/);
  let resolve, closed = 0;
  const context = { resume: () => new Promise(r => { resolve = r; }), close: async () => { closed++; } };
  const g = browserFixture({ makeContext: () => context });
  const priming = g.duck.primeAudio(); g.duck.stop(); resolve(); await priming;
  assert.equal(g.duck.primedContext, null); assert.equal(closed, 1);
});

test('camera status reads local state at startup and via a tool without starting capture or sending frames', async t => {
  let calls = 0;
  const f = browserFixture({ companionStore: { preferences: {}, memories: [] }, cameraStatus: () => {
    calls++; return { camera_active: true, name_sharing: false, face_count: 1, possibly_recognized_name: null };
  }, fetchImpl: async url => url.endsWith('/health') ? Response.json({ ready: true, companionVersion: 1, instructions: profile.instructions, tools: [] }) : new Response('v=0\r\nanswer') });
  t.after(() => f.duck.stop()); await f.duck.start(); f.channel.onopen();
  assert.ok(f.channel.messages[0].session.tools.some(x => x.name === 'get_camera_status'));
  assert.equal(calls, 1, 'startup reads existing state but does not enable a camera');
  f.channel.onmessage({ data: JSON.stringify({ type: 'response.done', response: { id: 'r', status: 'completed', output: [
    { type: 'function_call', name: 'get_camera_status', call_id: 'camera', arguments: '{}' },
  ] } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  const result = JSON.parse(f.channel.messages.find(x => x.item?.call_id === 'camera').item.output).result;
  assert.equal(result.possibly_recognized_name, null); assert.equal(result.face_count, 1);
  assert.ok(!JSON.stringify(result).includes('descriptor'));
});


test('live camera context reaches session instructions, updates on changes and speech gates the local speaker probe', async t => {
  const activities = [];
  let status = { camera_active: true, name_sharing: true, recognized_people: [{ name: 'Michael' }], possible_speaker_name: null };
  const f = browserFixture({ companionStore: { preferences: {}, memories: [] }, cameraStatus: () => status,
    onSpeechActivity: value => activities.push(value),
    fetchImpl: async url => url.endsWith('/health') ? Response.json({ ready: true, companionVersion: 1, instructions: profile.instructions, tools: [] }) : new Response('v=0\r\nanswer') });
  t.after(() => f.duck.stop()); await f.duck.start(); f.channel.onopen();
  assert.match(f.channel.messages[0].session.instructions, /Michael/);
  assert.match(f.channel.messages[0].session.instructions, /vóór elk inhoudelijk antwoord get_camera_status/);
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(activities.at(-1), true);
  status = { ...status, possible_speaker_name: 'Michael' };
  f.duck.updateCameraContext();
  assert.match(f.channel.messages.at(-1).session.instructions, /"possible_speaker_name":"Michael"/);
  const count = f.channel.messages.length; f.duck.updateCameraContext();
  assert.equal(f.channel.messages.length, count, 'identical frames do not flood the channel');
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_stopped' });
  assert.equal(activities.at(-1), false);
  status = { camera_active: true, name_sharing: false }; f.duck.updateCameraContext();
  assert.ok(!f.channel.messages.at(-1).session.instructions.includes('Michael'));
  assert.match(f.channel.messages.at(-1).session.instructions, /Gebruik geen eerdere cameranaam/);
  f.duck.stop(); assert.equal(activities.at(-1), false);
});
