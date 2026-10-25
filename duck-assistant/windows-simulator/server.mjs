// Loopback-only SDP exchange and Google lookup; keys never enter the browser or Vite.
import http from 'node:http';
import { googleSearch, DEFAULT_SEARCH_MODEL, GoogleSearchError } from './search-google.mjs';
import { searchTool, searchInstructions } from './search-tools.mjs';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const profile = JSON.parse(readFileSync(new URL('./session.json', import.meta.url)));

export function createConversationServer({
  apiKey = process.env.OPENAI_API_KEY?.trim(),
  model = process.env.DUCK_OPENAI_MODEL || profile.model,
  fetchImpl = fetch,
  googleKey = process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim(),
  googleModel = process.env.DUCK_GOOGLE_MODEL || DEFAULT_SEARCH_MODEL,
  origins = ['http://localhost:5173', 'http://127.0.0.1:5173'],
} = {}) {
  let activeSearch = false;
  const searches = [];
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    };
    // Host validation also prevents DNS rebinding to this loopback-only helper.
    const port = res.socket.localPort;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
      reply(403, 'Host geweigerd.');
      return;
    }
    const origin = req.headers.origin;
    if (!origins.includes(origin)) {
      reply(403, 'Open de simulator op http://localhost:5173.');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      reply(204, '');
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      reply(200, JSON.stringify({ ready: Boolean(apiKey), model, googleSearch: Boolean(googleKey), searchVersion: 1 }), 'application/json');
      return;
    }
    if (req.method !== 'POST' || !['/session', '/search'].includes(req.url)) {
      reply(404, 'Onbekend adres.');
      return;
    }
    if (!apiKey) {
      reply(503, 'Start start.ps1 en vul daar je OpenAI API-key in.');
      return;
    }
    if (req.url === '/search') {
      if (!googleKey) { reply(503, 'Google zoeken is uitgeschakeld. Start start.ps1 met een Google API-key.'); return; }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(415, 'JSON-zoekvraag verwacht.'); return; }
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      let acquired = false;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8192) { reply(413, 'Zoekvraag te groot.'); return; }
          chunks.push(chunk);
        }
        let args;
        try { args = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, 'Ongeldige JSON-zoekvraag.'); return; }
        if (!args || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000 || Object.keys(args).some(k => k !== 'query')) {
          reply(400, 'Geef één concrete zoekvraag van maximaal 1000 tekens.'); return;
        }
        const now = Date.now();
        while (searches.length && searches[0] < now - 60000) searches.shift();
        if (activeSearch || searches.length >= 10) { reply(429, 'Even wachten: er loopt al een zoekopdracht of de zoeklimiet is bereikt.'); return; }
        activeSearch = true; acquired = true; searches.push(now);
        const result = await googleSearch(args.query.trim(), { apiKey: googleKey, model: googleModel, fetchImpl,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        if (!res.destroyed) reply(200, JSON.stringify(result), 'application/json');
      } catch (error) {
        if (!res.destroyed) reply(502, error.name === 'TimeoutError' ? 'Google zoeken duurde te lang. Probeer opnieuw.' :
          error instanceof GoogleSearchError ? error.message : 'Google zoeken is niet bereikbaar of leverde ongeldige gegevens.');
      } finally { if (acquired) activeSearch = false; }
      return;
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/sdp') {
      reply(415, 'SDP-aanbod verwacht.');
      return;
    }
    try {
      let sdp = '';
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 131072) {
          reply(413, 'Het verbindingsaanbod is te groot.');
          return;
        }
        sdp += chunk.toString('utf8');
      }
      if (!sdp.startsWith('v=0') || !sdp.includes('m=audio')) {
        reply(400, 'Ongeldig audio-aanbod.');
        return;
      }
      const form = new FormData();
      form.set('sdp', sdp);
      // WebRTC negotiates its audio format in SDP; the robot uses PCM over WS.
      form.set('session', JSON.stringify({ ...profile, model, ...(googleKey ? { tools: [searchTool], tool_choice: 'auto', instructions: profile.instructions + searchInstructions } : {}) }));
      const upstream = await fetchImpl('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!upstream.ok) {
        // Do not forward untrusted upstream text that could echo a credential.
        const messages = {
          401: 'OpenAI weigert de API-key. Controleer de key in het PowerShell-venster.',
          403: 'Je OpenAI-project heeft geen toegang tot dit Realtime-model.',
          404: `Realtime-model niet beschikbaar: ${model}. Stel DUCK_OPENAI_MODEL in als je een ander model wilt gebruiken.`,
          429: 'OpenAI-limiet bereikt. Controleer API-tegoed, facturering en gebruikslimieten.',
        };
        reply(502, messages[upstream.status] || `OpenAI kon de sessie niet starten (HTTP ${upstream.status}).`);
        return;
      }
      const answer = await upstream.text();
      if (!answer.startsWith('v=0')) {
        reply(502, 'OpenAI stuurde geen geldig verbindingsantwoord.');
        return;
      }
      reply(200, answer, 'application/sdp');
    } catch {
      if (!res.writableEnded) reply(502, 'OpenAI is niet bereikbaar of de verbinding duurde te lang. Probeer opnieuw.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.error('OPENAI_API_KEY ontbreekt. Start het hulpprogramma met start.ps1.');
    process.exitCode = 1;
  } else {
    const server = createConversationServer();
    server.requestTimeout = 15000;
    server.on('error', () => {
      console.error('Poort 8787 is bezet. Sluit een eerder gestart gespreksvenster en probeer opnieuw.');
      process.exitCode = 1;
    });
    server.listen(8787, '127.0.0.1', () => {
      console.log('Gesprekshulp gereed. Laat dit venster open.');
      console.log('Ververs http://localhost:5173 en klik op Start gesprek.');
    });
  }
}
