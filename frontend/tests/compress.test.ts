import assert from 'node:assert/strict';
import test from 'node:test';
import {gunzipSync} from 'node:zlib';
import {compressionSupported, gzip, shouldCompress} from '../src/compress.ts';

test('the first chunk of a file is always tried', () => {
  assert.equal(shouldCompress(null), true);
});

test('already-compressed data such as PNG is sent as it is', () => {
  assert.equal(shouldCompress({ratio: 1.0, compressBytesPerSecond: 80e6, networkBytesPerSecond: 1e6}), false);
  assert.equal(shouldCompress({ratio: 0.97, compressBytesPerSecond: 80e6, networkBytesPerSecond: 1e6}), false);
});

test('compressible data is compressed on a slow link and sent raw on a fast one', () => {
  const sbd = {ratio: 0.63, compressBytesPerSecond: 25e6};
  assert.equal(shouldCompress({...sbd, networkBytesPerSecond: 5e6}), true);
  assert.equal(shouldCompress({...sbd, networkBytesPerSecond: 110e6}), false);
});

test('missing speed measurements fall back to the size saving alone', () => {
  assert.equal(shouldCompress({ratio: 0.6, compressBytesPerSecond: 0, networkBytesPerSecond: 0}), true);
});

test('gzip output restores to the original bytes', async () => {
  assert.equal(compressionSupported(), true);
  const original = new TextEncoder().encode('SpatialBridge '.repeat(4096));
  const compressed = new Uint8Array(await gzip(original.buffer));
  assert.ok(compressed.byteLength < original.byteLength / 10);
  assert.deepEqual(new Uint8Array(gunzipSync(compressed)), original);
});
