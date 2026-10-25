import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createConversationServer, profile } from './server.mjs';
import { DuckConversation } from './client.mjs';
import { install } from './install.mjs';

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
  const game = 'function jawOpenNow() { return Math.min(1, pickJawNow() + Math.max(flap, padJaw)); }';
  await writeFile(path.join(root, 'app/index.html'), index);
  await writeFile(path.join(root, 'app/src/game/game.js'), game);
  await install(root);
  const first = await readFile(path.join(root, 'app/src/game/game.js'), 'utf8');
  await install(root);
  assert.equal(await readFile(path.join(root, 'app/src/game/game.js'), 'utf8'), first);
  assert.ok(first.includes('getConversationJaw()'));
  assert.equal(await readFile(path.join(root, 'app/index.html.before-conversation'), 'utf8'), index);
  assert.equal(await readFile(path.join(root, 'app/src/game/game.js.before-conversation'), 'utf8'), game);
  assert.equal((await readFile(path.join(root, 'app/index.html'), 'utf8')).split('/src/duck-conversation/panel.mjs').length, 2);
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
