// Exercise the actual patched vendor source and bundled model. These are
// numerical/protocol regression tests, not claims about physical gaze accuracy.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const source = resolve(process.argv[2]);
const vendorRequire = createRequire(join(source, 'package.json'));
const ts = vendorRequire('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, filename);
};
const tf = vendorRequire('@tensorflow/tfjs');
const { fitScreenCalibration, readScreenCalibration, mapScreenPoint } = require(join(source, 'src/ScreenCalibration.ts'));
const WebEyeTrack = require(join(source, 'src/WebEyeTrack.ts')).default;
const WebcamClient = require(join(source, 'src/WebcamClient.ts')).default;
const targets = [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]];
// Camera output can be shifted outside the screen range and have cross-axis
// coupling. Clipping or fitting to already-smoothed values loses information.
const camera = ([x, y]) => [2 + 0.08 * x + 0.025 * y, -3 - 0.06 * y + 0.015 * x];
const points = targets.map(target => ({ target, samples: [-1, 0, 1].map(jitter => camera([target[0] + jitter * 0.002, target[1] - jitter * 0.002])) }));
const near = (actual, expected) => actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-7, `${actual} != ${expected}`));

async function checkWorkerOrdering() {
  const operations = [];
  const messages = [];
  let release;
  class ControlledTracker {
    async initialize() { return false; }
    async step() {
      operations.push('step:start');
      await new Promise(resolveStep => { release = resolveStep; });
      operations.push('step:end');
      return { timestamp: 1 };
    }
    beginCalibrationPoint() { operations.push('reset'); }
    applyCalibration() { throw new Error('rank deficient'); }
  }
  const worker = { postMessage: message => messages.push(message) };
  const code = ts.transpileModule(readFileSync(join(source, 'src/WebEyeTrackWorker.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, { self: worker, exports: {}, console, require: () => ControlledTracker });
  const send = (type, payload) => worker.onmessage({ data: { type, payload } });
  const flush = () => new Promise(resolveFlush => setImmediate(resolveFlush));
  send('init', {});
  await flush();
  assert.ok(messages.some(message => message.type === 'ready'));
  send('step', { frame: {}, timestamp: 1 });
  send('beginCalibrationPoint');
  await flush();
  assert.deepEqual(operations, ['step:start'], 'Reset must not overtake an awaited inference');
  release();
  await flush();
  assert.deepEqual(operations, ['step:start', 'step:end', 'reset']);
  send('step', { frame: {}, timestamp: 1 });
  await flush();
  assert.equal(operations.length, 3, 'Duplicate video timestamps must not become new samples');
  send('applyCalibration');
  send('beginCalibrationPoint');
  await flush();
  assert.ok(messages.some(message => message.type === 'error' && message.phase === 'applyCalibration' && message.message === 'rank deficient'));
  assert.equal(operations.at(-1), 'reset', 'A failed command must not leave the worker queue blocked');
}

async function main() {
  await checkWorkerOrdering();
  await tf.setBackend('cpu');
  const fit = fitScreenCalibration(points);
  for (const heldOut of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) near(mapScreenPoint(fit, camera(heldOut)), heldOut);
  assert.throws(() => fitScreenCalibration(points.slice(1)), /five/);
  assert.throws(() => fitScreenCalibration(points.map(point => ({ ...point, samples: [[0, 0], [0, 0], [0, 0]] }))), /do not vary/);
  assert.throws(() => fitScreenCalibration(points.map((point, i) => ({ ...point, samples: [[i, i], [i, i], [i, i]] }))), /cannot distinguish/);
  assert.throws(() => readScreenCalibration({}), /incomplete/);
  assert.throws(() => readScreenCalibration({ ...fit, matrix: [[NaN, 0, 0], [0, 1, 0]] }), /incomplete/);

  const tracker = new WebEyeTrack();
  tracker.loaded = true;
  tracker.adapt = () => { throw new Error('Calibration must never retrain the network after fitting its coordinate map.'); };
  for (const point of points) {
    tracker.beginCalibrationPoint();
    assert.equal(tracker.calibrate(...point.target), false, 'A reset must discard the previous target');
    tracker.recentCalibrationFrames = point.samples.map((sample, index) => ({ point: sample, timestamp: index / 30 }));
    assert.equal(tracker.calibrate(...point.target), true);
  }
  assert.equal(tracker.applyCalibration(), true);
  for (const point of points) near(mapScreenPoint(tracker.screenCalibration, camera(point.target)), point.target);

  // Save/restore the real bundled neural model via TF.js IO handlers. Assert the
  // weights AND coordinate mapping survive, including an actual prediction.
  const assets = resolve(__dirname, '../src/renderer/public/web');
  const modelJson = JSON.parse(readFileSync(join(assets, 'model.json'), 'utf8'));
  const shards = modelJson.weightsManifest.flatMap(group => group.paths.map(path => readFileSync(join(assets, path))));
  const bytes = Buffer.concat(shards);
  const model = await tf.loadLayersModel(tf.io.fromMemory({
    modelTopology: modelJson.modelTopology,
    weightSpecs: modelJson.weightsManifest.flatMap(group => group.weights),
    weightData: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }));
  tracker.blazeGaze.model = model;
  const inputs = tf.tidy(() => model.inputs.map(input => tf.ones(input.shape.map(size => size ?? 1)).mul(0.1)));
  const prediction = model.predict(inputs);
  const before = Array.from(prediction.dataSync());
  const beforeMapped = mapScreenPoint(fit, before);
  prediction.dispose();
  let saved;
  tf.io.registerSaveRouter(url => url === 'indexeddb://view-regression' ? { save: async artifacts => {
    saved = artifacts;
    return { modelArtifactsInfo: tf.io.getModelArtifactsInfoForJSON(artifacts) };
  } } : null);
  tf.io.registerLoadRouter(url => url === 'indexeddb://view-regression' ? { load: async () => saved } : null);
  await tracker.saveCalibration('view-regression');
  assert.deepEqual(saved.userDefinedMetadata.screenCalibration, tracker.screenCalibration);
  const restored = new WebEyeTrack();
  restored.faceLandmarkerClient.initialize = async () => {};
  assert.equal(await restored.initialize(undefined, 'view-regression'), true);
  const afterPrediction = restored.blazeGaze.model.predict(inputs);
  const after = Array.from(afterPrediction.dataSync());
  assert.deepEqual(after, before, 'Saving and fitting must leave neural predictions unchanged');
  near(mapScreenPoint(restored.screenCalibration, after), beforeMapped);
  delete saved.userDefinedMetadata;
  const incomplete = new WebEyeTrack();
  incomplete.faceLandmarkerClient.initialize = async () => {};
  await assert.rejects(incomplete.initialize(undefined, 'view-regression'), /incomplete/);
  tf.dispose(inputs);
  afterPrediction.dispose();
  model.dispose();
  restored.blazeGaze.model.dispose();
  incomplete.blazeGaze.model.dispose();

  // Teardown of an old camera must not detach a newer provider's stream.
  let stopped = 0;
  const oldStream = { getTracks: () => [{ stop: () => stopped++ }] };
  const newStream = {};
  const video = { srcObject: newStream, removeEventListener() {}, pause() { throw new Error('Stopped newer camera'); } };
  global.document = { getElementById: () => video };
  const webcam = new WebcamClient('gaze-camera');
  webcam.stream = oldStream;
  webcam.stopWebcam();
  webcam.stopWebcam();
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, newStream);
  console.log('WebEyeTrack regression checks passed: worker ordering, unique frames, affine fit, held-out predictions, rank failure, fixed network, complete restore, camera ownership.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
