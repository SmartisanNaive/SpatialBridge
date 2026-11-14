import type {PngResult} from './png-core';

export type PngOptimization = {file: File; reason: PngResult['reason']};

export function optimizePng(file: File, options: {
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
} = {}): Promise<PngOptimization> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('图片优化已取消', 'AbortError'));
      return;
    }
    let worker: Worker;
    try { worker = new Worker(new URL('./png.worker.ts', import.meta.url), {type: 'module'}); }
    catch { resolve({file, reason: 'unsupported'}); return; }
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {cleanup(); reject(new DOMException('图片优化已取消', 'AbortError'));};
    const fallback = () => {cleanup(); resolve({file, reason: 'unchanged'});};
    options.signal?.addEventListener('abort', abort, {once: true});
    worker.onerror = fallback;
    worker.onmessageerror = fallback;
    worker.onmessage = ({data}: MessageEvent<
      {type: 'progress'; bytes: number} | {type: 'done'; result: PngResult; hash?: string}
    >) => {
      if (data.type === 'progress') {options.onProgress?.(data.bytes); return;}
      cleanup();
      if (!data.result.blob || !data.hash) {resolve({file, reason: data.result.reason}); return;}
      const stem = file.name.replace(/\.png$/i, '').slice(0, 40);
      resolve({file: new File([data.result.blob], `${stem}.optimized-${data.hash.slice(0, 16)}.png`, {
        type: 'image/png', lastModified: file.lastModified,
      }), reason: 'optimized'});
    };
    worker.postMessage({file});
  });
}
