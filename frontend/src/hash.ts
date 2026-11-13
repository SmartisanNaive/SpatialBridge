import {sha256} from '@noble/hashes/sha2.js';

export async function sha256Hex(
  buffer: ArrayBuffer,
  subtle: Pick<SubtleCrypto, 'digest'> | null = globalThis.crypto?.subtle ?? null,
) {
  const digest = subtle
    ? new Uint8Array(await subtle.digest('SHA-256', buffer))
    : sha256(new Uint8Array(buffer));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}
