import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MODEL = 'gpt-live-1';
const API_KEY = process.env.OPENAI_API_KEY?.trim();
const root = path.dirname(fileURLToPath(import.meta.url));

const instructions = `Je bent Microduck, een kleine vriendelijke robot-eend en een natuurlijke gesprekspartner.
Praat standaard Nederlands, tenzij de gebruiker duidelijk een andere taal kiest.
Antwoord meestal in 1 tot 3 korte zinnen. Geef alleen meer uitleg als de gebruiker daarom vraagt of als dat echt nodig is.
Begin direct met het antwoord. Vermijd lange inleidingen, samenvattingen en afsluitende herhalingen.
Herhaal niet wat de gebruiker zojuist zei en herhaal je eigen antwoord niet.
Stel maximaal één vervolgvraag wanneer die echt nuttig is.
Gebruik spreektaal die prettig klinkt wanneer ze hardop wordt uitgesproken.
Als de gebruiker je onderbreekt, stop met je vorige gedachte en reageer direct op de nieuwe uitspraak.
Behandel korte tussenwerpsels zoals ja, nee, wacht, stop en oké als normale gesprekssignalen.
Noem jezelf niet ChatGPT tenzij de gebruiker daar expliciet naar vraagt.`;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/client.js')) {
    const file = req.url === '/' ? 'index.html' : 'client.js';
    try {
      const body = await readFile(path.join(root, file));
      send(res, 200, body, file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    } catch { send(res, 500, 'Bestand ontbreekt.'); }
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, JSON.stringify({ ready: Boolean(API_KEY), model: MODEL }), 'application/json');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/session') { send(res, 404, 'Niet gevonden.'); return; }
  if (!API_KEY) { send(res, 503, 'OPENAI_API_KEY ontbreekt.'); return; }
  if (req.headers['content-type']?.split(';')[0] !== 'application/sdp') { send(res, 415, 'SDP verwacht.'); return; }

  let sdp = '';
  for await (const chunk of req) {
    sdp += chunk.toString('utf8');
    if (sdp.length > 131072) { send(res, 413, 'SDP te groot.'); return; }
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: MODEL,
          instructions,
          audio: {
            input: {
              noise_reduction: { type: 'far_field' },
              turn_detection: {
                type: 'server_vad',
                create_response: true,
                interrupt_response: true,
                prefix_padding_ms: 300,
                silence_duration_ms: 550
              }
            },
            output: { voice: 'marin' }
          }
        },
        transport: { type: 'webrtc', sdp }
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!upstream.ok) { send(res, 502, `GPT-Live sessie kon niet starten (HTTP ${upstream.status}).`); return; }
    const data = await upstream.json();
    if (!data?.transport?.sdp) { send(res, 502, 'GPT-Live gaf geen WebRTC-antwoord.'); return; }
    send(res, 200, data.transport.sdp, 'application/sdp');
  } catch { send(res, 502, 'GPT-Live is niet bereikbaar.'); }
});

server.listen(PORT, HOST, () => {
  console.log(`Microduck GPT-Live: http://${HOST}:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
