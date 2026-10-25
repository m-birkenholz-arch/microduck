import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConversationServer } from './server.mjs';
import { googleVision } from './vision-google.mjs';
import { captureCamera, validVisionRequest, MAX_CAMERA_IMAGE } from './vision.mjs';
import { SearchTools } from './search-tools.mjs';
import { DuckConversation } from './client.mjs';

const image = 'data:image/jpeg;base64,/9j/2Q==';
const question = 'Wat heb ik vast?';
const answer = { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'Je houdt een appel vast.' }] } }] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function server(t, options = {}) {
  const app = createConversationServer({ apiKey: 'openai-secret', googleKey: 'google-secret', ...options });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.address().port}`;
  const request = (body, headers = {}) => fetch(url + '/vision', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { request, url };
}

test('camera capture requires separate consent and decoded video, shrinks one frame and clears local pixels', () => {
  let captures = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() { captures++; } }), toDataURL: () => image };
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 2 };
  assert.throws(() => captureCamera(video, { allowed: false }), /vink/);
  assert.throws(() => captureCamera({ ...video, readyState: 1 }, { allowed: true }), /nog geen beeld/);
  assert.equal(captures, 0);
  assert.equal(captureCamera(video, { allowed: true, makeCanvas: () => canvas }), image);
  assert.equal(captures, 1); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  canvas.toDataURL = () => 'data:image/jpeg;base64,' + 'a'.repeat(MAX_CAMERA_IMAGE);
  assert.throws(() => captureCamera(video, { allowed: true, makeCanvas: () => canvas }), /te groot/);
  assert.equal(canvas.width, 0);
});

test('Gemini gets exactly one JPEG and question, with server key and no search or face descriptors', async () => {
  const signal = new AbortController().signal;
  const result = await googleVision(question, image, { apiKey: 'secret', signal, fetchImpl: async (url, init) => {
    assert.match(url, /gemini-3.8-flash:generateContent$/); assert.ok(!url.includes('secret'));
    assert.equal(init.headers['x-goog-api-key'], 'secret'); assert.equal(init.signal, signal);
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].parts.length, 2);
    assert.deepEqual(body.contents[0].parts[0], { inline_data: { mime_type: 'image/jpeg', data: '/9j/2Q==' } });
    assert.equal(body.contents[0].parts[1].text, question); assert.equal(body.tools, undefined);
    assert.match(body.systemInstruction.parts[0].text, /Identificeer geen personen/);
    return Response.json(answer);
  } });
  assert.equal(result.text, 'Je houdt een appel vast.'); assert.equal(result.provider, 'Google Gemini beeldanalyse');
  assert.ok(!JSON.stringify(result).includes('base64')); assert.ok(!JSON.stringify(result).includes('hidden'));
});

test('invalid images, URLs, provider failures and empty replies fail without leaking provider text or keys', async () => {
  let requests = 0;
  for (const value of ['https://example.com/a.jpg', 'data:image/png;base64,aGVsbG8=', 'data:image/jpeg;base64,aGVsbG8=']) {
    await assert.rejects(googleVision(question, value, { apiKey: 'secret', fetchImpl: async () => { requests++; } }), /Ongeldig/);
  }
  assert.equal(requests, 0); assert.equal(validVisionRequest({ question, image, url: 'extra' }), false);
  for (const status of [400, 401, 403, 404, 429, 500]) {
    await assert.rejects(googleVision(question, image, { apiKey: 'secret', fetchImpl: async () => new Response('secret', { status }) }), error => !error.message.includes('secret'));
  }
  await assert.rejects(googleVision(question, image, { apiKey: 'secret', fetchImpl: async () => Response.json({}) }), /niet beoordelen/);
});

test('vision helper enforces origin, type, size, schema and readiness before sending a camera frame', async t => {
  let requests = 0;
  const { request, url } = await server(t, { fetchImpl: async () => { requests++; return Response.json(answer); } });
  const health = await (await fetch(url + '/health', { headers: { Origin: 'http://localhost:5173' } })).json();
  assert.equal(health.googleVision, true);
  assert.equal((await request({ question, image }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request({ question, image }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request({ question, image: 'a'.repeat(260000) })).status, 413);
  for (const value of [{ question }, { question: '', image }, { question, image, extra: true }, { question, image: 'https://example.com/a.jpg' }]) {
    assert.equal((await request(value)).status, 400);
  }
  assert.equal(requests, 0);
  const response = await request({ question, image }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.text, 'Je houdt een appel vast.'); assert.equal(data.image, undefined);
  assert.ok(!JSON.stringify(data).includes('secret')); assert.equal(requests, 1);
  const disabled = await server(t, { googleKey: '', fetchImpl: async () => { throw Error('must not call'); } });
  assert.equal((await disabled.request({ question, image })).status, 503);
});

test('vision and search share concurrency and per-minute quota', async t => {
  let release;
  const { request, url } = await server(t, { fetchImpl: () => new Promise(resolve => { release = () => resolve(Response.json(answer)); }) });
  const pending = request({ question, image });
  while (!release) await tick();
  const search = await fetch(url + '/search', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'weer' }) });
  assert.equal(search.status, 429); release(); assert.equal((await pending).status, 200);
});

function clientFixture(fetchImpl) {
  let allowed = true, captures = 0;
  const results = [], controller = new AbortController();
  const duck = new DuckConversation({ cameraStatus: () => ({ camera_active: true, image_sharing: allowed }), captureImage: () => { captures++; return image; }, onVisionResult: result => results.push(result), fetchImpl });
  duck.controller = controller; duck.visionReady = true;
  return { duck, results, revoke() { allowed = false; duck.channel = { readyState: 'open', send() {} }; duck.updateCameraContext(); }, captures: () => captures };
}

test('voice vision tool captures only on request, returns evidence and creates one spoken response without exposing the image to Realtime', async () => {
  const f = clientFixture(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8787/vision'); assert.deepEqual(JSON.parse(init.body), { question, image });
    return Response.json({ provider: 'Google Gemini beeldanalyse', text: 'Een appel.' });
  });
  const sent = [];
  const tools = new SearchTools({ send: event => sent.push(event), search: async () => {}, extraTools: { analyze_camera: (args, signal) => f.duck.analyzeCamera(args, signal) } });
  assert.equal(f.captures(), 0);
  const event = { type: 'response.done', response: { id: 'r', status: 'completed', output: [1, 2].map(n => ({ type: 'function_call', name: 'analyze_camera', call_id: 'c' + n, arguments: JSON.stringify({ question }) })) } };
  tools.handleEvent(event); await tick();
  assert.equal(f.captures(), 1, 'one capture per batch');
  assert.equal(sent.filter(x => x.type === 'response.create').length, 1);
  assert.ok(!JSON.stringify(sent).includes('base64'));
  assert.equal(f.results.length, 1);
  tools.handleEvent(event); await tick(); assert.equal(f.captures(), 1, 'duplicate events do not upload again');
  f.duck.stop();
});

test('revoking image consent aborts a pending analysis and blocks capture while disabled', async () => {
  let signal, release;
  const f = clientFixture(async (url, init) => { signal = init.signal; return new Promise(resolve => { release = () => resolve(Response.json({ text: 'stale' })); }); });
  const pending = f.duck.analyzeCamera({ question }, new AbortController().signal);
  f.revoke(); assert.equal(signal.aborted, true); release();
  await assert.rejects(pending, /gestopt/); assert.equal(f.results.length, 0);
  await assert.rejects(f.duck.analyzeCamera({ question }, new AbortController().signal), /vink/);
  assert.equal(f.captures(), 1); f.duck.channel = null; f.duck.stop();
});

test('barge-in and Stop abort pending vision work and cannot speak a late result', async () => {
  for (const closing of [false, true]) {
    let signal, release;
    const f = clientFixture(async (url, init) => { signal = init.signal; return new Promise(resolve => { release = () => resolve(Response.json({ text: 'stale' })); }); });
    const sent = [];
    const tools = new SearchTools({ send: event => sent.push(event), search: async () => {}, extraTools: { analyze_camera: (args, signal) => f.duck.analyzeCamera(args, signal) } });
    tools.handleEvent({ type: 'response.done', response: { id: 'r', status: 'completed', output: [{ type: 'function_call', name: 'analyze_camera', call_id: 'c', arguments: JSON.stringify({ question }) }] } });
    tools.cancel(closing); assert.equal(signal.aborted, true); release(); await tick();
    assert.equal(f.results.length, 0); assert.equal(sent.filter(x => x.type === 'response.create').length, 0);
    f.duck.stop();
  }
});
