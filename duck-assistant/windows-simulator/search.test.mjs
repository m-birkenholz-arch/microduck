import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createConversationServer, profile } from './server.mjs';
import { googleSearch, safeSource } from './search-google.mjs';
import { SearchTools, searchTool, searchInstructions } from './search-tools.mjs';

const origin = 'http://localhost:5173';
const googleResult = () => ({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden thought' }, { text: 'Barack Obama was de 44e president van de Verenigde Staten.' }] }, groundingMetadata: {
  webSearchQueries: ['Obama president'],
  groundingChunks: [{ web: { uri: 'https://www.obamalibrary.gov/', title: 'Obama Presidential Library' } }, { web: { uri: 'javascript:alert(1)', title: 'unsafe' } }],
  searchEntryPoint: { renderedContent: '<div>Google Search suggesties</div>' },
} }] });
async function server(t, options = {}) {
  const app = createConversationServer({ apiKey: 'openai-secret', googleKey: 'google-secret', ...options });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.address().port}`;
  const request = (body, route = '/search', headers = {}) => fetch(url + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { request, url };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function toolFixture(search = async () => ({ text: 'feiten', sources: [], searchSuggestions: 'HTML' })) {
  const sent = [], results = [], states = [];
  const tool = new SearchTools({ send: value => sent.push(value), search, onResult: value => results.push(value), onState: value => states.push(value) });
  const event = { type: 'response.done', response: { id: 'resp1', status: 'completed', output: [{ type: 'function_call', name: 'search_web', call_id: 'call1', arguments: '{"query":"Wie was Obama?"}' }] } };
  return { tool, sent, results, states, event };
}

test('Google REST request uses the private key and a grounded result, never hidden thinking', async () => {
  const result = await googleSearch('Wie was Obama?', { apiKey: 'google-secret', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.ok(!url.includes('google-secret'));
    assert.equal(init.headers['x-goog-api-key'], 'google-secret');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    assert.match(body.contents[0].parts[0].text, /Wie was Obama/);
    return Response.json(googleResult());
  } });
  assert.equal(result.sources.length, 1);
  assert.match(result.text, /44e president/); assert.ok(!result.text.includes('hidden thought'));
  assert.match(result.searchSuggestions, /Google Search/);
  assert.equal(safeSource('javascript:alert(1)'), null);
  assert.equal(safeSource('https://name:secret@example.com'), null);
});

test('ungrounded, blocked, empty and quota-failed Google results cannot masquerade as evidence', async () => {
  for (const data of [{}, { candidates: [{ content: { parts: [{ text: 'guessed fact' }] } }] }, { candidates: [{ finishReason: 'SAFETY' }] }]) {
    await assert.rejects(googleSearch('vraag', { apiKey: 'key', fetchImpl: async () => Response.json(data) }), /geen controleerbare/);
  }
  await assert.rejects(googleSearch('vraag', { apiKey: 'key', fetchImpl: async () => new Response('google-secret', { status: 429 }) }), /zoeklimiet/);
});

test('helper search exposes sources and capability, keeps both keys private and registers the tool only with Google enabled', async t => {
  const { request, url } = await server(t, { fetchImpl: async (url, init) => {
    if (url.endsWith('/realtime/calls')) {
      const session = JSON.parse(init.body.get('session'));
      assert.deepEqual(session.tools, [searchTool]);
      assert.equal(session.instructions, profile.instructions + searchInstructions);
      assert.equal(session.audio.output.voice, profile.audio.output.voice);
      return new Response('v=0\r\nanswer');
    }
    return Response.json(googleResult());
  } });
  const health = await (await fetch(url + '/health', { headers: { Origin: origin } })).json();
  assert.equal(health.googleSearch, true); assert.equal(health.searchVersion, 1);
  const response = await request({ query: 'Wie was Obama?' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('google-secret') && !text.includes('openai-secret'));
  assert.match(text, /obamalibrary/);
  const sdp = await fetch(url + '/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/sdp' }, body: 'v=0\r\nm=audio\r\n' });
  assert.equal(sdp.status, 200);
});

test('disabled Google leaves ordinary voice conversations available and reports setup, never a paid search', async t => {
  let requests = 0;
  const { request, url } = await server(t, { googleKey: '', fetchImpl: async (url, init) => {
    requests++; assert.ok(!JSON.parse(init.body.get('session')).tools); return new Response('v=0\r\nanswer');
  } });
  assert.equal((await request({ query: 'Obama' })).status, 503);
  assert.equal(requests, 0);
  const response = await fetch(url + '/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/sdp' }, body: 'v=0\r\nm=audio\r\n' });
  assert.equal(response.status, 200); assert.equal(requests, 1);
});

test('search endpoint rejects hostile origins, rebinding, malformed and oversized input before spending quota', async t => {
  let requests = 0;
  const { request, url } = await server(t, { fetchImpl: async () => { requests++; return Response.json(googleResult()); } });
  for (const body of [null, {}, { query: '' }, { query: 1 }, { query: 'x'.repeat(1001) }, { query: 'Obama', url: 'http://private/' }]) {
    assert.equal((await request(body)).status, 400);
  }
  assert.equal((await request({ query: 'x'.repeat(9000) })).status, 413);
  assert.equal((await request({ query: 'Obama' }, '/search', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request({ query: 'Obama' }, '/search', { 'Content-Type': 'text/plain' })).status, 415);
  const badHost = await new Promise((resolve, reject) => {
    const req = httpRequest(url + '/search', { method: 'POST', headers: { Host: 'evil.example', Origin: origin } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(badHost, 403); assert.equal(requests, 0);
});

test('Google and network errors do not echo keys or provider payloads', async t => {
  const a = await server(t, { fetchImpl: async () => { throw new Error('network google-secret openai-secret'); } });
  const b = await server(t, { fetchImpl: async () => new Response('google-secret openai-secret', { status: 403 }) });
  for (const { request } of [a, b]) {
    const response = await request({ query: 'Obama' }); const text = await response.text();
    assert.equal(response.status, 502); assert.ok(!text.includes('secret'));
  }
});

test('only one search runs concurrently and excess calls are rate-limited', async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const { request } = await server(t, { fetchImpl: async () => { began(); return new Promise(resolve => { release = () => resolve(Response.json(googleResult())); }); } });
  const first = request({ query: 'Obama' }); await started;
  assert.equal((await request({ query: 'physics' })).status, 429);
  release(); assert.equal((await first).status, 200);
});

test('completed function calls return evidence then one tool-free spoken answer; duplicates do not search twice', async () => {
  const f = toolFixture();
  f.tool.handleEvent({ type: 'response.function_call_arguments.done', ...f.event.response.output[0] });
  assert.equal(f.states.length, 0);
  f.tool.handleEvent(f.event); f.tool.handleEvent(f.event); await tick();
  assert.equal(f.states.length, 1); assert.equal(f.results.length, 1); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].item.type, 'function_call_output'); assert.equal(f.sent[0].item.call_id, 'call1');
  const output = JSON.parse(f.sent[0].item.output); assert.equal(output.ok, true); assert.ok(!('searchSuggestions' in output));
  assert.deepEqual(f.sent[1], { type: 'response.create', response: { tool_choice: 'none' } });
});

test('interruption aborts lookup, completes the old call as cancelled and cannot speak stale results', async () => {
  let release, signal;
  const f = toolFixture((query, s) => { signal = s; return new Promise(resolve => { release = resolve; }); });
  f.tool.handleEvent({ type: 'response.created', response: { id: 'resp1' } });
  f.tool.handleEvent(f.event);
  f.tool.handleEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(signal.aborted, true);
  assert.equal(JSON.parse(f.sent[0].item.output).ok, false);
  release({ text: 'stale' }); await tick();
  assert.equal(f.results.length, 0); assert.equal(f.sent.length, 1);
  f.tool.handleEvent(f.event); await tick(); assert.equal(f.sent.length, 1);
});

test('Stop drops pending results without sending to a closed channel; cancelled or failed responses never search', async () => {
  let release;
  const f = toolFixture(() => new Promise(resolve => { release = resolve; }));
  for (const status of ['cancelled', 'failed', 'incomplete']) f.tool.handleEvent({ ...f.event, response: { ...f.event.response, status } });
  assert.equal(f.states.length, 0);
  f.tool.handleEvent(f.event); f.tool.cancel(true);
  release({ text: 'stale' }); await tick(); assert.equal(f.sent.length, 0);
});

test('invalid or unsupported calls and failed lookups return honest errors without losing the conversation', async () => {
  for (const change of [{ name: 'run_command' }, { arguments: 'bad json' }, { arguments: 'null' }, { arguments: '{"query":""}' }, {}]) {
    const f = toolFixture(async () => { throw new Error('Google tijdelijk niet beschikbaar'); });
    Object.assign(f.event.response.output[0], change);
    f.tool.handleEvent(f.event); await tick();
    assert.equal(JSON.parse(f.sent[0].item.output).ok, false);
    assert.equal(f.sent[1].type, 'response.create'); assert.equal(f.results.length, 0);
  }
});
