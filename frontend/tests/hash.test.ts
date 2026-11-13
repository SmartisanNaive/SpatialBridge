import assert from 'node:assert/strict';
import test from 'node:test';
import {sha256Hex} from '../src/hash.ts';

const bytes = (value: string) => new TextEncoder().encode(value).buffer;

test('SHA-256 fallback works without Web Crypto for the empty input and a standard vector', async () => {
  assert.equal(
    await sha256Hex(bytes(''), null),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    await sha256Hex(bytes('abc'), null),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('Web Crypto remains the preferred SHA-256 implementation', async () => {
  const calls: string[] = [];
  const subtle = {
    async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
      calls.push(String(algorithm));
      return crypto.subtle.digest(algorithm, data);
    },
  };
  assert.equal(
    await sha256Hex(bytes('abc'), subtle),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.deepEqual(calls, ['SHA-256']);
});
