import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createConversationServer, profile } from './server.mjs';
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
  assert.equal(profile.audio.output.voice, 'verse');
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
  const channel = { readyState: 'open', close() { this.closed = true; } };
  const peer = {
    addTrack() {}, createDataChannel: () => channel,
    createOffer: async () => ({ sdp: offer }), setLocalDescription: async () => {},
    setRemoteDescription: async () => {}, close() { this.closed = true; },
  };
  const audio = { muted: false, pause() {}, play: async () => {} };
  const context = { resume: async () => {}, close: async () => {} };
  const states = [];
  const duck = new DuckConversation({
    mediaDevices: { getUserMedia: async () => stream }, makePeer: () => peer,
    makeAudio: () => audio, makeContext: () => context,
    fetchImpl: async url => new Response(url.endsWith('/health') ? '{"ready":true}' : 'v=0\r\nanswer'),
    onStatus: (text, active) => states.push({ text, active }), ...extra,
  });
  return { duck, track, peer, channel, audio, states, stream };
}

test('barge-in immediately mutes playback, the next answer unmutes it, Stop releases the mic', async () => {
  const f = browserFixture();
  await f.duck.start();
  f.duck.handleEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(f.audio.muted, true);
  assert.equal(f.track.stopped, false); // Listening continues during interruption.
  f.duck.handleEvent({ type: 'output_audio_buffer.started' });
  assert.equal(f.audio.muted, false);
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
