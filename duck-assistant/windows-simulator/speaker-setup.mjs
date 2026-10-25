import { mkdir, readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_SHA256 } from './speaker-backend.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url)), runtime = path.join(directory, 'speaker-runtime');
await mkdir(runtime, { recursive: true });
await copyFile(path.join(directory, 'speaker-package.json'), path.join(runtime, 'package.json'));
// npm.cmd is a batch script on Windows. Invoke it through cmd, with no user text.
const windows = process.platform === 'win32';
const code = await new Promise((resolve, reject) => {
  const child = spawn(windows ? 'cmd.exe' : 'npm', windows ? ['/d', '/s', '/c', 'npm.cmd install --omit=dev --no-audit --no-fund'] : ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runtime, stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('exit', resolve);
});
if (code !== 0) throw Error('Lokaal stempakket installeren mislukt. Controleer Node.js en internet.');
const target = path.join(runtime, 'model.onnx');
let valid = false;
try { valid = createHash('sha256').update(await readFile(target)).digest('hex') === MODEL_SHA256; } catch { /* First installation. */ }
if (!valid) {
  console.log('Stemmodel downloaden (27 MB)...');
  const response = await fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx', { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error('Stemmodel downloaden mislukt.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== 26530550 || createHash('sha256').update(bytes).digest('hex') !== MODEL_SHA256) throw Error('Stemmodelcontrole mislukt. Probeer de installatie opnieuw.');
  await writeFile(target + '.tmp', bytes); await rm(target, { force: true }); await rename(target + '.tmp', target);
}
console.log('Lokaal stemmodel gereed.');
