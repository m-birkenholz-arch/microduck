import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { drawFaceOverlay } from './face-panel.mjs';
import { createFaceEngine } from './face-engine.mjs';
import { FaceGallery, LocalFaceCamera, FACE_STORAGE_KEY, FACE_ENGINE, descriptor } from './face-local.mjs';
import { setupFaceAssets, verifyFaceAssets, faceAssets } from './face-assets.mjs';

const vector = (index = 0, jitter = 0) => Array.from({ length: 128 }, (_, n) => n === index ? 1 : n === 127 ? jitter : 0);
const samples = index => [vector(index), vector(index, 0.01), vector(index, 0.02)];
const storageFixture = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), data }; };
const face = (index = 0, { score = 0.95, size = 160 } = {}) => ({ descriptor: vector(index), detection: { score, box: { x: 100, y: 100, width: size, height: size } } });

test('explicit enrollment persists only three descriptors and a label, supports match/removal and stays separate from companion memory', () => {
  const storage = storageFixture(), gallery = new FaceGallery(storage, () => 'id');
  gallery.add('Michael', samples(0));
  const saved = JSON.parse(storage.getItem(FACE_STORAGE_KEY));
  assert.equal(saved.engine, FACE_ENGINE); assert.deepEqual(Object.keys(saved.profiles[0]), ['id', 'name', 'samples']);
  assert.equal(storage.data.size, 1); assert.ok(!storage.getItem(FACE_STORAGE_KEY).includes('data:image'));
  const next = new FaceGallery(storage); assert.equal(next.match(vector(0, 0.03)).name, 'Michael');
  assert.equal(next.match(vector(1)), null);
  next.remove('id'); assert.equal(new FaceGallery(storage).profiles.length, 0);
});

test('unknown, low-quality or ambiguous descriptors cannot become a name', () => {
  assert.equal(descriptor(new Array(128).fill(0)), null); assert.equal(descriptor([1]), null);
  const bad = vector(); bad[1] = NaN; assert.equal(descriptor(bad), null);
  const gallery = new FaceGallery(storageFixture(), () => 'id');
  assert.throws(() => gallery.add('A', [vector()]), /drie/);
  assert.throws(() => gallery.add('A', [vector(0), vector(1), vector(0)]), /veranderde/);
  gallery.add('A', samples(0));
  assert.throws(() => gallery.add('B', samples(0)), /bestaand/);
  gallery.profiles.push({ id: 'other', name: 'B', samples: samples(0) });
  assert.equal(gallery.match(vector()), null, 'ambiguous identities abstain');
});

test('storage failure does not claim a face was saved; invalid or incompatible profiles are ignored', () => {
  const gallery = new FaceGallery({ getItem: () => null, setItem() { throw new Error('quota'); } }, () => 'id');
  assert.throws(() => gallery.add('Michael', samples(0)), /bewaren lukt niet/); assert.equal(gallery.profiles.length, 0);
  const storage = storageFixture(); storage.setItem(FACE_STORAGE_KEY, '{bad');
  assert.match(new FaceGallery(storage).loadError, /niet worden gelezen/);
  storage.setItem(FACE_STORAGE_KEY, JSON.stringify({ engine: 'other-model', profiles: [{ id: 'id', name: 'M', samples: samples(0) }] }));
  assert.equal(new FaceGallery(storage).profiles.length, 0);
});

function cameraFixture({ detect = async () => [face()], getUserMedia, makeEngine, onResult } = {}) {
  const timers = new Map(), states = [], results = [], constraints = []; let timerId = 0, clock = 1000;
  const track = { stopped: false, stop() { this.stopped = true; } }, stream = { getTracks: () => [track] };
  const video = { play: async () => {}, pause() { this.paused = true; } };
  const gallery = new FaceGallery(storageFixture(), () => 'id');
  const camera = new LocalFaceCamera({ video, gallery, makeEngine: makeEngine || (async () => ({ detect })),
    mediaDevices: { getUserMedia: async options => { constraints.push(options); return getUserMedia ? getUserMedia() : stream; } },
    onState: message => states.push(message), onResult: value => { results.push(value); onResult?.(value); },
    schedule: fn => { timers.set(++timerId, fn); return timerId; }, unschedule: id => timers.delete(id), now: () => clock });
  const frame = async () => {
    const [id, fn] = timers.entries().next().value; timers.delete(id); fn();
    await new Promise(resolve => setTimeout(resolve, 0)); clock += 750;
  };
  return { camera, gallery, video, stream, track, states, results, constraints, timers, frame, tick: amount => { clock += amount; } };
}

test('camera asks only for video, requires three clear measurements and only returns a name after explicit sharing', async () => {
  const f = cameraFixture(); await f.camera.start();
  assert.equal(f.constraints[0].audio, false); assert.equal(f.video.srcObject, f.stream);
  assert.throws(() => f.camera.learn('Michael'), /even duidelijk/);
  await f.frame(); await f.frame();
  assert.equal(f.results.at(-1).learnReady, true);
  f.camera.learn('Michael'); assert.equal(f.gallery.profiles.length, 1);
  await f.frame(); await f.frame(); await f.frame();
  assert.equal(f.results.at(-1).match.name, 'Michael');
  assert.equal(f.camera.status().possibly_recognized_name, null);
  f.camera.shareName = true; assert.equal(f.camera.status().possibly_recognized_name, 'Michael');
  assert.ok(!JSON.stringify(f.camera.status()).includes('samples'));
  f.tick(6000); assert.equal(f.camera.status().possibly_recognized_name, null, 'stale matches are not shared');
  f.camera.stop(); assert.equal(f.camera.shareName, false); assert.equal(f.video.srcObject, null);
  assert.equal(f.track.stopped, true); assert.equal(f.timers.size, 0);
});

test('multiple faces, tiny or low-score faces invalidate enrollment and clear previous recognition immediately', async () => {
  let faces = [face()]; const f = cameraFixture({ detect: async () => faces });
  f.gallery.add('Michael', samples(0)); await f.camera.start(); await f.frame(); await f.frame();
  assert.ok(f.camera.match);
  for (const value of [[face(), face(1)], [], [face(0, { score: 0.5 })], [face(0, { size: 50 })], [face(1)]]) {
    faces = value; await f.frame(); assert.equal(f.camera.match, null);
  }
  f.camera.stop();
});

test('Stop during model loading never opens the camera and Stop during camera permission releases late tracks', async () => {
  let resolveModel; const f = cameraFixture({ makeEngine: () => new Promise(resolve => { resolveModel = resolve; }) });
  const starting = f.camera.start(); f.camera.stop(); resolveModel({ detect: async () => [] }); await starting;
  assert.equal(f.constraints.length, 0); assert.equal(f.timers.size, 0);
  let resolveCamera; const g = cameraFixture({ getUserMedia: () => new Promise(resolve => { resolveCamera = resolve; }) });
  const otherStart = g.camera.start(); while (!resolveCamera) await new Promise(resolve => setTimeout(resolve, 0));
  g.camera.stop(); resolveCamera(g.stream); await otherStart;
  assert.equal(g.track.stopped, true); assert.equal(g.video.srcObject, null); assert.equal(g.timers.size, 0);
});

test('a detection completing after Stop cannot update the UI, enroll, share or restart its loop', async () => {
  let resolve; const f = cameraFixture({ detect: () => new Promise(r => { resolve = r; }) });
  const starting = f.camera.start(); while (!resolve) await new Promise(r => setTimeout(r, 0));
  f.camera.stop(); const count = f.results.length;
  resolve([face()]); await starting;
  assert.equal(f.results.length, count); assert.equal(f.timers.size, 0);
  assert.throws(() => f.camera.learn('Michael'), /duidelijk/);
  assert.equal(f.camera.status().camera_active, false);
});

test('permission errors release the camera, but inference errors pause recognition while keeping the preview open', async () => {
  const denied = new Error('denied'); denied.name = 'NotAllowedError';
  const f = cameraFixture({ getUserMedia: async () => { throw denied; } }); await f.camera.start();
  assert.match(f.states.at(-1), /Camera geweigerd/); assert.equal(f.camera.active, false);
  const g = cameraFixture({ detect: async () => { throw new Error('GPU reset'); } }); await g.camera.start();
  assert.equal(g.track.stopped, false); assert.equal(g.camera.active, true); assert.equal(g.video.srcObject, g.stream);
  assert.equal(g.timers.size, 0); assert.match(g.states.at(-1), /GPU reset/);
  assert.equal(g.camera.status().recognition_available, false);
  assert.equal(g.camera.status().possibly_recognized_name, null);
  g.camera.stop(); assert.equal(g.track.stopped, true);
});

test('model installer pins upstream files, validates hashes, reuses a valid cache and rejects corrupted download data', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duck-face-assets-')); t.after(() => rm(root, { recursive: true, force: true }));
  const data = Buffer.from('test-model');
  const manifest = { repository: 'owner/repo', commit: 'abc', files: [{ source: 'weights/model', target: 'models/model', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }] };
  let requests = 0;
  const fetchImpl = async url => { requests++; assert.equal(url, 'https://raw.githubusercontent.com/owner/repo/abc/weights/model'); return new Response(data); };
  const directory = await setupFaceAssets(root, { manifest, fetchImpl }); await verifyFaceAssets(directory, manifest);
  await setupFaceAssets(root, { manifest, fetchImpl }); assert.equal(requests, 1);
  await writeFile(path.join(directory, 'models/model'), 'corrupt');
  await assert.rejects(verifyFaceAssets(directory, manifest), /beschadigd/);
  await assert.rejects(setupFaceAssets(root, { manifest, fetchImpl: async () => new Response('corrupt') }), /Controle/);
  assert.match(faceAssets.commit, /^[a-f0-9]{40}$/);
  assert.equal(faceAssets.files.filter(x => /manifest/.test(x.target)).length, 3);
  assert.ok(faceAssets.files.some(x => /LICENSE/.test(x.target)));
});


test('recognition retry reuses the camera stream and resumes a single loop, while Stop clears a pending retry', async () => {
  let failing = true;
  const f = cameraFixture({ detect: async () => { if (failing) throw new Error('transient inference'); return [face()]; } });
  await f.camera.start(); assert.ok(f.camera.recognitionError); assert.equal(f.track.stopped, false);
  failing = false; await f.camera.retry();
  assert.equal(f.camera.recognitionError, ''); assert.equal(f.constraints.length, 1);
  assert.equal(f.timers.size, 1); assert.equal(f.camera.status().recognition_available, true);
  await f.camera.retry(); assert.equal(f.timers.size, 1, 'retry is disabled while recognition is already running');
  f.camera.stop();
  let resolve;
  const g = cameraFixture({ detect: async () => { throw new Error('first error'); } });
  await g.camera.start();
  g.camera.engine.detect = () => new Promise(r => { resolve = r; });
  const retry = g.camera.retry(); g.camera.stop(); resolve([face()]); await retry;
  assert.equal(g.timers.size, 0); assert.equal(g.camera.match, null); assert.equal(g.camera.active, false);
});

function engineFixture({ detect, reloadModels } = {}) {
  let backend = 'webgl', calls = 0, disposed = 0, snapshots = 0;
  const switches = [];
  const api = {
    tf: { getBackend: () => backend, setBackend: async value => { switches.push(value); backend = value; return true; } },
    nets: Object.fromEntries(['tinyFaceDetector', 'faceLandmark68TinyNet', 'faceRecognitionNet'].map(key => [key, { dispose() { disposed++; } }])),
    TinyFaceDetectorOptions: class {},
    detectAllFaces(input) { assert.ok(input.width > 0 && input.height > 0); calls++; return {
      withFaceLandmarks: () => ({ withFaceDescriptors: () => detect ? detect(backend, calls) : Promise.resolve([face()]) }),
    }; },
  };
  const snapshot = { width: 0, height: 0, getContext: () => ({ drawImage() { snapshots++; } }) };
  const engine = createFaceEngine(api, { makeCanvas: () => snapshot, reloadModels: reloadModels || (async () => {}) });
  return { engine, snapshot, switches, calls: () => calls, disposed: () => disposed, snapshots: () => snapshots };
}

test('engine waits for decoded video data, uses a local snapshot and clears its pixels after inference', async () => {
  const f = engineFixture();
  const video = { videoWidth: 0, videoHeight: 0, readyState: 0 };
  assert.deepEqual(await f.engine.detect(video), []); assert.equal(f.calls(), 0);
  Object.assign(video, { videoWidth: 640, videoHeight: 480, readyState: 1 });
  assert.deepEqual(await f.engine.detect(video), []); assert.equal(f.calls(), 0);
  video.readyState = 2; assert.equal((await f.engine.detect(video)).length, 1);
  assert.equal(f.snapshots(), 1); assert.equal(f.snapshot.width, 0); assert.equal(f.snapshot.height, 0);
});

test('GPU inference failure switches to CPU once, reloads model weights and succeeds without closing video', async () => {
  let reloaded = 0;
  const f = engineFixture({ detect: async backend => { if (backend === 'webgl') throw new Error('shader compile failed'); return [face()]; }, reloadModels: async () => { reloaded++; } });
  const video = { width: 640, height: 480 };
  assert.equal((await f.engine.detect(video)).length, 1);
  assert.deepEqual(f.switches, ['cpu']); assert.equal(reloaded, 1); assert.equal(f.disposed(), 3);
  assert.equal(f.engine.backend, 'cpu'); assert.equal(f.snapshot.width, 0);
  await f.engine.detect(video); assert.equal(reloaded, 1, 'no repeated GPU retries');
});

test('engine serializes Stop/start overlap and does not loop forever when both backends fail', async () => {
  let release, started = 0;
  const f = engineFixture({ detect: () => { started++; return new Promise(resolve => { release = resolve; }); } });
  const first = f.engine.detect({ width: 640, height: 480 });
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const second = f.engine.detect({ width: 640, height: 480 }); assert.equal(started, 1);
  release([face()]); await first;
  while (started !== 2) await new Promise(resolve => setTimeout(resolve, 0));
  release([face()]); await second;
  const broken = engineFixture({ detect: async () => { throw new Error('inference unavailable'); } });
  await assert.rejects(broken.engine.detect({ width: 640, height: 480 }), /inference unavailable/);
  assert.equal(broken.calls(), 2); assert.deepEqual(broken.switches, ['cpu']); assert.equal(broken.snapshot.width, 0);
});


test('a rectangle canvas failure cannot close the video or pause recognition', async () => {
  const canvas = { hidden: false, getContext() { throw new Error('2D context unavailable'); } };
  const f = cameraFixture({ onResult: result => { assert.equal(drawFaceOverlay(canvas, {}, result.faces, result.match), false); } });
  await f.camera.start(); assert.equal(f.camera.active, true); assert.equal(f.track.stopped, false);
  assert.equal(f.camera.recognitionError, ''); assert.equal(f.timers.size, 1); assert.equal(canvas.hidden, true);
  f.camera.stop(); assert.equal(f.track.stopped, true);
});

test('a video track ended by Windows closes the camera with a reason and removes track listeners', async () => {
  const f = cameraFixture(), listeners = new Map();
  f.stream.getVideoTracks = () => [f.track];
  f.track.addEventListener = (name, callback) => listeners.set(name, callback);
  f.track.removeEventListener = name => listeners.delete(name);
  await f.camera.start(); listeners.get('ended')();
  assert.equal(f.camera.active, false); assert.equal(f.track.stopped, true);
  assert.equal(f.timers.size, 0); assert.equal(listeners.size, 0);
  assert.match(f.states.at(-1), /browser of Windows gestopt/);
});
