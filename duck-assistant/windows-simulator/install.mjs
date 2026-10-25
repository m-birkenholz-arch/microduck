import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const scriptTag = '<script type="module" src="/src/duck-conversation/panel.mjs"></script>';
const jawImport = 'import { getConversationJaw } from "../duck-conversation/mouth.mjs";\n';
const oldJaw = 'Math.max(flap, padJaw)';
const newJaw = 'Math.max(flap, padJaw, getConversationJaw())';

export async function install(simulatorPath) {
  const app = path.join(path.resolve(simulatorPath), 'app');
  const indexPath = path.join(app, 'index.html');
  const gamePath = path.join(app, 'src', 'game', 'game.js');
  let index = await readFile(indexPath, 'utf8');
  let game = await readFile(gamePath, 'utf8');
  // Validate both edits before writing either file. Unknown versions fail safely.
  if (!index.includes(scriptTag) && !index.includes('</body>')) throw new Error('index.html heeft geen body-einde.');
  if (!game.includes(newJaw) && game.split(oldJaw).length !== 2) throw new Error('Snavelcode wijkt af; installatie afgebroken zonder wijzigingen.');
  const destination = path.join(app, 'src', 'duck-conversation');
  await mkdir(destination, { recursive: true });
  for (const name of ['panel.mjs', 'client.mjs', 'mouth.mjs']) {
    await copyFile(path.join(source, name), path.join(destination, name));
  }
  for (const file of [indexPath, gamePath]) {
    try { await access(file + '.before-conversation'); }
    catch { await copyFile(file, file + '.before-conversation'); }
  }
  if (!index.includes(scriptTag)) index = index.replace('</body>', `  ${scriptTag}\n  </body>`);
  if (!game.includes(jawImport)) game = jawImport + game;
  game = game.replace(oldJaw, newJaw);
  await writeFile(gamePath, game, 'utf8');
  await writeFile(indexPath, index, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Geef het pad naar microduck-simulator op.');
    await install(process.argv[2]);
    console.log('Gespreksknoppen en snavelanimatie geinstalleerd.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
