// Local-only SDP exchange. The project key never enters the browser or Vite.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const profile = JSON.parse(readFileSync(new URL('./session.json', import.meta.url)));

export function createConversationServer({
  apiKey = process.env.OPENAI_API_KEY?.trim(),
  model = process.env.DUCK_OPENAI_MODEL || profile.model,
  fetchImpl = fetch,
  origins = ['http://localhost:5173', 'http://127.0.0.1:5173'],
} = {}) {
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
      reply(200, JSON.stringify({ ready: Boolean(apiKey), model }), 'application/json');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/session') {
      reply(404, 'Onbekend adres.');
      return;
    }
    if (!apiKey) {
      reply(503, 'Start start.ps1 en vul daar je OpenAI API-key in.');
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
      form.set('session', JSON.stringify({ ...profile, model }));
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
