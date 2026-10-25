import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { faceAssets, verifyFaceAssets } from './face-assets.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const scriptTag = '<script type="module" src="/src/duck-conversation/panel.mjs"></script>';
const jawImport = 'import { getConversationJaw } from "../duck-conversation/mouth.mjs";\n';
const oldJaw = 'Math.max(flap, padJaw)';
const newJaw = 'Math.max(flap, padJaw, getConversationJaw())';
const legacyMotionImport = 'import { stepConversationHead } from "../duck-conversation/motion.mjs";\n';
const motionImport = 'import { stepConversationHead, getConversationBody, useConversationStand } from "../duck-conversation/motion.mjs";\n';
const oldHead = 'for (let h = 0; h < 4; h++) headSmooth[h] += HEAD_ALPHA * (headTarget[h] - headSmooth[h]);';
const legacyHeadHook = `// Conversation head offsets use the existing policy command and smoothing.
    const conversationHead = stepConversationHead(CTRL_DT,
      !inputLocked && mode === "walk" && loco === "legs" && !headMode &&
      !recovery && !grab && !scriptRun && !customPolicy && postKickLock === 0 &&
      !standTimer && Math.hypot(cmd[0], cmd[1], cmd[2]) < 0.001);
    for (let h = 0; h < 4; h++) headSmooth[h] += HEAD_ALPHA * (headTarget[h] + conversationHead[h] - headSmooth[h]);`;
const allowedHelper = `function conversationMotionAllowed() {
    const move = effectiveCmd();
    return !inputLocked && mode === "walk" && loco === "legs" && !headMode &&
      !recovery && !grab && !scriptRun && !customPolicy && postKickLock === 0 &&
      !standTimer && Math.hypot(move[0], move[1], move[2]) < 0.001;
  }

  `;
const headHook = `// Conversation head and body offsets use the existing policy commands.
    const conversationAllowed = conversationMotionAllowed();
    const conversationHead = stepConversationHead(CTRL_DT, conversationAllowed);
    for (let h = 0; h < 4; h++) headSmooth[h] += HEAD_ALPHA * (headTarget[h] + conversationHead[h] - headSmooth[h]);
    // Body x/y/yaw are unbound in training. Only z/roll/pitch may be set.
    cmd.fill(0, 7, 13);
    if (conversationAllowed) {
      const body = getConversationBody();
      cmd[9] = body[0]; cmd[10] = body[1]; cmd[11] = body[2];
    }`;
const recoveryChoice = 'if (recovery?.state === "recovering") return sessions.stand;';
const standChoice = 'if (useConversationStand(conversationMotionAllowed())) return sessions.stand;';

export async function install(simulatorPath, { faceAssetsPath = path.join(source, 'face-assets') } = {}) {
  const app = path.join(path.resolve(simulatorPath), 'app');
  const indexPath = path.join(app, 'index.html');
  const gamePath = path.join(app, 'src', 'game', 'game.js');
  let index = await readFile(indexPath, 'utf8');
  let game = await readFile(gamePath, 'utf8');
  // Validate both edits before writing either file. Unknown versions fail safely.
  if (!index.includes(scriptTag) && !index.includes('</body>')) throw new Error('index.html heeft geen body-einde.');
  if (!game.includes(newJaw) && game.split(oldJaw).length !== 2) throw new Error('Snavelcode wijkt af; installatie afgebroken zonder wijzigingen.');
  if (!game.includes(headHook) && !game.includes(legacyHeadHook) && game.split(oldHead).length !== 2) throw new Error('Hoofdsturing wijkt af; installatie afgebroken zonder wijzigingen.');
  if (!game.includes('function buildObs() {') || game.split(recoveryChoice).length !== 2) throw new Error('Policyselectie wijkt af; installatie afgebroken zonder wijzigingen.');
  if (game.includes('function conversationMotionAllowed()') && !game.includes(allowedHelper)) throw new Error('Gespreksbesturing wijkt af; installatie afgebroken zonder wijzigingen.');
  let copyFaceAssets = false;
  try { await access(faceAssetsPath); copyFaceAssets = true; } catch { /* Optional until installed with -FaceCamera. */ }
  if (copyFaceAssets) await verifyFaceAssets(faceAssetsPath);
  const destination = path.join(app, 'src', 'duck-conversation');
  await mkdir(destination, { recursive: true });
  for (const name of ['speaker-local.mjs', 'speaker-panel.mjs', 'speaker-worklet.mjs', 'vision.mjs', 'panel.mjs', 'client.mjs', 'mouth.mjs', 'motion.mjs', 'gestures.mjs', 'voice.mjs', 'voice-worklet.mjs', 'search-tools.mjs', 'companion.mjs', 'wake.mjs', 'photo.mjs', 'face-local.mjs', 'face-engine.mjs', 'face-panel.mjs']) {
    await copyFile(path.join(source, name), path.join(destination, name));
  }
  if (copyFaceAssets) for (const entry of faceAssets.files) {
    const target = path.join(app, 'public', 'duck-face', entry.target);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(faceAssetsPath, entry.target), target);
  }
  for (const file of [indexPath, gamePath]) {
    try { await access(file + '.before-conversation'); }
    catch { await copyFile(file, file + '.before-conversation'); }
  }
  if (!index.includes(scriptTag)) index = index.replace('</body>', `  ${scriptTag}\n  </body>`);
  if (!game.includes(jawImport)) game = jawImport + game;
  game = game.replace(oldJaw, newJaw);
  game = game.replace(legacyMotionImport, '');
  if (!game.includes(motionImport)) game = motionImport + game;
  game = game.replace(legacyHeadHook, headHook).replace(oldHead, headHook);
  if (!game.includes(allowedHelper)) game = game.replace('function buildObs() {', allowedHelper + 'function buildObs() {');
  if (!game.includes(standChoice)) game = game.replace(recoveryChoice, recoveryChoice + '\n    ' + standChoice);
  await writeFile(gamePath, game, 'utf8');
  await writeFile(indexPath, index, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Geef het pad naar microduck-simulator op.');
    await install(process.argv[2]);
    console.log('Gespreksknoppen, snavel, hoofd en lichaam geinstalleerd.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
