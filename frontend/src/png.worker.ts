import {optimizePngData} from './png-core';
import {sha256} from '@noble/hashes/sha2.js';

self.onmessage = async ({data}: MessageEvent<{file: File}>) => {
  try {
    let previous = 0;
    const result = await optimizePngData(data.file, (bytes) => {
      const now = performance.now();
      if (now - previous > 250) {
        self.postMessage({type: 'progress', bytes});
        previous = now;
      }
    });
    let hash: string | undefined;
    if (result.blob) {
      const digest = sha256.create();
      for (let start = 0; start < result.blob.size; start += 1024 * 1024) {
        digest.update(new Uint8Array(await result.blob.slice(start, start + 1024 * 1024).arrayBuffer()));
      }
      hash = Array.from(digest.digest(), (value) => value.toString(16).padStart(2, '0')).join('');
    }
    self.postMessage({type: 'done', result, hash});
  } catch {
    // An optional optimization must never prevent an otherwise valid upload.
    self.postMessage({type: 'done', result: {reason: 'unchanged'}});
  }
};
