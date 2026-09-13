#!/usr/bin/env node
import sharp from "sharp";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const frameSize = 128;
const columnInset = 20;
const columnEdges = [0, 726, 1408, 2091, 2816];
const rows = [
  { top: 250, height: 530 },
  { top: 900, height: 525 },
];

const jobs = [
  { source: resolve(root, "vendor/owl-sprites/idle-source.jpg"), output: resolve(root, "src/renderer/public/sprites/owl-idle.png") },
  { source: resolve(root, "vendor/owl-sprites/thinking-source.jpg"), output: resolve(root, "src/renderer/public/sprites/owl-working.png") },
];

function isConnectedBackground(r, g, b) {
  const minimum = Math.min(r, g, b);
  const maximum = Math.max(r, g, b);
  return minimum >= 218 && maximum - minimum <= 32;
}

async function isolateFrame(source, column, row) {
  const columnLeft = columnEdges[column];
  const columnRight = columnEdges[column + 1];
  const extracted = await sharp(source)
    .extract({
      left: columnLeft + columnInset,
      top: row.top,
      width: columnRight - columnLeft - columnInset * 2,
      height: row.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = extracted;
  const seen = new Uint8Array(info.width * info.height);
  const queue = new Int32Array(info.width * info.height);
  let head = 0;
  let tail = 0;

  const enqueue = (index) => {
    if (seen[index]) return;
    const offset = index * info.channels;
    if (!isConnectedBackground(data[offset], data[offset + 1], data[offset + 2])) return;
    seen[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < info.width; x++) {
    enqueue(x);
    enqueue((info.height - 1) * info.width + x);
  }
  for (let y = 0; y < info.height; y++) {
    enqueue(y * info.width);
    enqueue(y * info.width + info.width - 1);
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % info.width;
    const y = Math.floor(index / info.width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < info.width) enqueue(index + 1);
    if (y > 0) enqueue(index - info.width);
    if (y + 1 < info.height) enqueue(index + info.width);
  }

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < seen.length; index++) {
    const offset = index * info.channels;
    if (seen[index]) data[offset + 3] = 0;
    if (data[offset + 3] === 0) continue;
    const x = index % info.width;
    const y = Math.floor(index / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error(`No artwork found in column ${column}, row ${row.top}`);

  const isolated = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const fitted = await sharp(isolated)
    .resize({ width: 116, height: 116, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((frameSize - fitted.info.width) / 2);
  const top = frameSize - fitted.info.height - 4;
  return sharp({ create: { width: frameSize, height: frameSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted.data, left, top }])
    .png()
    .toBuffer();
}

for (const job of jobs) {
  const frames = [];
  for (const row of rows) {
    for (let column = 0; column < columnEdges.length - 1; column++) {
      frames.push(await isolateFrame(job.source, column, row));
    }
  }
  await sharp({
    create: {
      width: frameSize * frames.length,
      height: frameSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(frames.map((input, index) => ({ input, left: index * frameSize, top: 0 })))
    .png()
    .toFile(job.output);
  console.log(`Built ${job.output}`);
}
