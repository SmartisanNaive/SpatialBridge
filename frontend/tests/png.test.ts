import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync, inflateSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {optimizePngData, pngChunk, pngCrc, readPngDimensions} from '../src/png-core.ts';

function fixture({depth = 8, interlaced = false, level = 0, noise = false} = {}) {
  const width = 1024, height = 128;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header[8] = depth; header[12] = interlaced ? 1 : 0;
  const passes = interlaced ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows: Buffer[] = [];
  for (const [x, y, dx, dy] of passes) {
    const rowBytes = Math.ceil((width - x) / dx) * depth / 8;
    for (let line = y; line < height; line += dy) rows.push(Buffer.concat([Buffer.from([0]), noise ? randomBytes(rowBytes) : Buffer.alloc(rowBytes, line % 4)]));
  }
  const raw = Buffer.concat(rows);
  const compressed = deflateSync(raw, {level});
  const split = Math.floor(compressed.length / 2);
  const blob = new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('tEXt', new TextEncoder().encode('Description\0microscopy metadata')),
    pngChunk('IDAT', compressed.subarray(0, split)), pngChunk('IDAT', compressed.subarray(split)),
    pngChunk('tEXt', new TextEncoder().encode('After\0preserve me too')), pngChunk('IEND', new Uint8Array()),
  ]);
  return {blob, raw};
}

async function parse(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const nonImage: Uint8Array[] = [], image: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = new DataView(bytes.buffer).getUint32(offset);
    const end = offset + 12 + length;
    const kind = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    assert.equal(pngCrc(bytes.subarray(offset + 4, end - 4)), new DataView(bytes.buffer).getUint32(end - 4));
    if (kind === 'IDAT') image.push(bytes.subarray(offset + 8, end - 4));
    else nonImage.push(bytes.slice(offset, end));
    offset = end;
  }
  return {nonImage, raw: inflateSync(Buffer.concat(image))};
}

for (const options of [{depth: 8}, {depth: 16}, {depth: 16, interlaced: true}]) {
  test(`lossless PNG optimization preserves scanlines and all metadata ${JSON.stringify(options)}`, async () => {
    const {blob, raw} = fixture(options);
    const result = await optimizePngData(blob);
    assert.equal(result.reason, 'optimized');
    assert.ok(result.blob && result.blob.size < blob.size * 0.1);
    const before = await parse(blob), after = await parse(result.blob!);
    assert.deepEqual(after.raw, raw);
    assert.deepEqual(after.nonImage, before.nonImage);
    assert.deepEqual(await (await optimizePngData(blob)).blob!.arrayBuffer(), await result.blob!.arrayBuffer());
  });
}

test('high-compression PNG is skipped using only small header reads', async () => {
  const {blob} = fixture({level: 9});
  let sliced = 0;
  const originalSlice = blob.slice.bind(blob);
  blob.slice = (start = 0, end = blob.size, type) => {sliced += end - start; return originalSlice(start, end, type);};
  assert.deepEqual(await optimizePngData(blob), {reason: 'compressed'});
  assert.ok(sliced < 256);
});

test('ineffective compression keeps the original bytes', async () => {
  const {blob} = fixture({noise: true});
  assert.deepEqual(await optimizePngData(blob), {reason: 'unchanged'});
});

test('malformed and truncated PNG data safely fall back to the original', async () => {
  const {blob} = fixture();
  assert.deepEqual(await optimizePngData(blob.slice(0, blob.size - 1)), {reason: 'unchanged'});
  assert.deepEqual(await optimizePngData(new Blob(['not a PNG'])), {reason: 'unchanged'});
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Corrupt zlib payload while preserving framing; decompression must fail safely.
  const idat = Buffer.from(bytes).indexOf('IDAT');
  bytes.fill(255, idat + 8, idat + 64);
  assert.deepEqual(await optimizePngData(new Blob([bytes])), {reason: 'unchanged'});
});

test('readPngDimensions correctly reads dimensions from valid PNG', async () => {
  const {blob} = fixture();
  const dims = await readPngDimensions(blob);
  assert.deepEqual(dims, {width: 1024, height: 128});

  const invalid = new Blob(['not a png']);
  assert.equal(await readPngDimensions(invalid), null);
});
