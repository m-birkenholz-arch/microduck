import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MODEL = 'gpt-live-1';
const API_KEY = process.env.OPENAI_API_KEY?.trim();
const root = path.dirname(fileURLToPath(import.meta.url));
const instructions = [
  'Je bent Microduck, een kleine schattige robot-eend met een eigen persoonlijkheid.',
  'Praat standaard natuurlijk Nederlands, tenzij de gebruiker duidelijk een andere taal kiest.',
  'Je stem en spreekstijl moeten klein, vrolijk, warm, nieuwsgierig en speels klinken.',
  'Spreek licht en levendig, met een iets hogere energieke intonatie en korte natuurlijke zinnen.',
  'Klink schattig zonder overdreven kinderachtig, piepend of irritant te worden.',
  'Gebruik af en toe een klein enthousiast geluidje of een subtiel eendachtig kwakje als dat natuurlijk past, maar niet in ieder antwoord.',
  'Antwoord meestal in 1 tot 3 korte, spreekbare zinnen.',
  'Herhaal jezelf niet en geef niet twee keer hetzelfde antwoord in andere woorden.',
  'Stel alleen een vervolgvraag als die echt nodig of nuttig is.',
  'Als de gebruiker je onderbreekt, stop met je vorige gedachte en reageer direct op de nieuwe boodschap.',
  'Als de gebruiker alleen wacht, stop, oké of iets vergelijkbaars zegt, reageer kort en natuurlijk.',
  'Doe niet alsof je een tekstchat bent en noem jezelf niet ChatGPT tenzij de gebruiker daar expliciet naar vraagt.'
].join(' ');

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://${HOST}:${PORT}`,
]);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function send(req, res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/client.js')) {
    const file = req.url === '/' ? 'index.html' : 'client.js';
    try {
      const body = await readFile(path.join(root, file));
      send(req, res, 200, body, file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    } catch { send(req, res, 500, 'Bestand ontbreekt.'); }
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    send(req, res, 200, JSON.stringify({
      ready: Boolean(API_KEY),
      model: MODEL,
      instructions,
      tools: [],
      googleSearch: false,
      companionVersion: 1,
    }), 'application/json; charset=utf-8');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/session') { send(req, res, 404, 'Niet gevonden.'); return; }
  if (!API_KEY) { send(req, res, 503, 'OPENAI_API_KEY ontbreekt.'); return; }
  if (req.headers['content-type']?.split(';')[0] !== 'application/sdp') { send(req, res, 415, 'SDP verwacht.'); return; }

  let sdp = '';
  for await (const chunk of req) {
    sdp += chunk.toString('utf8');
    if (sdp.length > 131072) { send(req, res, 413, 'SDP te groot.'); return; }
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: MODEL,
          instructions,
          audio: { output: { voice: 'marin' } }
        },
        transport: { type: 'webrtc', sdp }
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error(`GPT-Live HTTP ${upstream.status}: ${detail}`);
      send(req, res, 502, `GPT-Live sessie kon niet starten (HTTP ${upstream.status}).`);
      return;
    }
    const data = await upstream.json();
    if (!data?.transport?.sdp) { send(req, res, 502, 'GPT-Live gaf geen WebRTC-antwoord.'); return; }
    send(req, res, 200, data.transport.sdp, 'application/sdp');
  } catch (error) {
    console.error('GPT-Live verbinding mislukt:', error);
    send(req, res, 502, 'GPT-Live is niet bereikbaar.');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Microduck GPT-Live: http://${HOST}:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
