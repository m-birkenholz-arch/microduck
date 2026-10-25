import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const faceAssets = JSON.parse(await readFile(new URL('./face-assets.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function valid(bytes, entry) { return bytes.length === entry.bytes && digest(bytes) === entry.sha256; }
export async function verifyFaceAssets(directory, manifest = faceAssets) {
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(directory, entry.target));
    if (!valid(bytes, entry)) throw new Error(`Gezichtsmodel beschadigd: ${entry.target}. Installeer opnieuw met -FaceCamera.`);
  }
}
export async function setupFaceAssets(toolsDirectory, { fetchImpl = fetch, manifest = faceAssets } = {}) {
  const directory = path.join(toolsDirectory, 'face-assets');
  for (const entry of manifest.files) {
    const target = path.join(directory, entry.target);
    try { if (valid(await readFile(target), entry)) continue; } catch { /* Download missing/corrupt asset. */ }
    const url = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${entry.source}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Gezichtsmodel downloaden mislukt (HTTP ${response.status}): ${entry.target}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!valid(bytes, entry)) throw new Error(`Controle van gezichtsmodel mislukt: ${entry.target}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target + '.download', bytes); await rename(target + '.download', target);
  }
  await verifyFaceAssets(directory, manifest); return directory;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await setupFaceAssets(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
    console.log('Lokale gezichtsmodellen gedownload en SHA-256 gecontroleerd.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
