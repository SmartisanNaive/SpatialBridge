import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {packSbd, SBD_MAGIC} from '../src/sbd-package.ts';
import type {SbdManifest} from '../src/sbd-package.ts';

function fixture() {
  const values = new BigUint64Array([0n, 9007199254740993n]);
  const bytes = new Uint8Array(values.buffer);
  const manifest: SbdManifest = {
    format: 'sbd-extract', version: 1, source: {name: '原始.sbd', size: 5809336884},
    groups: [{path: '', attrs: []}],
    datasets: [{path: 'Registrations/0/OriginalCoordinates', dtype: 'uint64', shape: [1, 2], attrs: [], offset: 0, length: bytes.length}],
  };
  return {manifest, bytes};
}

test('the package retains 64-bit integer bytes and source sizes above 4 GiB', () => {
  const {manifest, bytes} = fixture();
  const buffer = packSbd(manifest, [bytes]);
  assert.equal(new TextDecoder().decode(buffer.slice(0, 8)), SBD_MAGIC);
  const length = new DataView(buffer).getUint32(8, true);
  const decoded = JSON.parse(new TextDecoder().decode(buffer.slice(12, 12 + length)));
  assert.equal(decoded.source.size, 5809336884);
  assert.equal(decoded.source.name, '原始.sbd');
  const data = new DataView(buffer, 12 + length);
  assert.equal(data.getBigUint64(8, true), 9007199254740993n);
});

test('regenerated packages have identical complete and upload-chunk digests', () => {
  const a = fixture();
  const b = fixture();
  const first = new Uint8Array(packSbd(a.manifest, [a.bytes]));
  const second = new Uint8Array(packSbd(b.manifest, [b.bytes]));
  const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
  assert.equal(hash(first), hash(second));
  for (let offset = 0; offset < first.length; offset += 32) {
    assert.equal(hash(first.slice(offset, offset + 32)), hash(second.slice(offset, offset + 32)));
  }
});
