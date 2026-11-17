import type {PngResult} from './png-core';
import {readPngDimensions} from './png-core';

export type PngOptimization = {file: File; reason: PngResult['reason']};

export async function generateClientThumbnail(file: Blob, maxWidth = 640): Promise<string> {
  // 1. 优先尝试使用现代浏览器支持的 createImageBitmap 原生下采样
  if (typeof createImageBitmap === 'function') {
    try {
      const dims = await readPngDimensions(file);
      let targetWidth = maxWidth;
      let targetHeight: number | undefined;
      if (dims && dims.width > 0 && dims.height > 0) {
        targetWidth = Math.min(maxWidth, dims.width);
        targetHeight = Math.max(1, Math.round((dims.height / dims.width) * targetWidth));
      }
      const bitmap = await createImageBitmap(file, {
        resizeWidth: targetWidth,
        ...(targetHeight ? {resizeHeight: targetHeight} : {}),
        resizeQuality: 'low',
      });
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return canvas.toDataURL('image/jpeg', 0.82);
      }
      bitmap.close();
    } catch {
      // 浏览器底层尺寸上限或内存限制时跳过
    }
  }

  // 2. 对于安全尺寸的小图像，通过 Image 标签下采样渲染
  if (file.size < 25 * 1024 * 1024 && typeof document !== 'undefined') {
    try {
      return await new Promise<string>((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, maxWidth / Math.max(1, img.width));
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          } else {
            reject(new Error('Canvas context unavailable'));
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Image decode error'));
        };
        img.src = url;
      });
    } catch {
      // 降级
    }
  }

  throw new Error('无法在当前浏览器环境下直接生成缩略图');
}

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
