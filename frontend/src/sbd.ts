export type SbdExtractionStats = {
  sourceBytes: number;
  outputBytes: number;
  readBytes: number;
  maxReadBytes: number;
  maxReadOffset: number;
  wasmBytes: number;
};

export type SbdExtraction = {file: File; stats: SbdExtractionStats};
export type SbdExtractionProgress = {stage: string; completed: number; total: number};

type WorkerReply =
  | {type: 'progress'; progress: SbdExtractionProgress}
  | {type: 'done'; buffer: ArrayBuffer; name: string; stats: SbdExtractionStats}
  | {type: 'error'; message: string};

/** The File is cloned as a file handle; its complete contents are never read here. */
export function extractSbd(file: File, options: {
  signal?: AbortSignal;
  onProgress?: (progress: SbdExtractionProgress) => void;
} = {}): Promise<SbdExtraction> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('提取已取消', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('./sbd.worker.ts', import.meta.url), {type: 'module'});
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (error: Error) => {cleanup(); reject(error);};
    const abort = () => fail(new DOMException('提取已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abort, {once: true});
    worker.onerror = (event) => fail(new Error(`无法启动 SBD 本地提取：${event.message}`));
    worker.onmessageerror = () => fail(new Error('无法读取 SBD 本地提取结果'));
    worker.onmessage = ({data}: MessageEvent<WorkerReply>) => {
      if (data.type === 'progress') options.onProgress?.(data.progress);
      else if (data.type === 'error') fail(new Error(data.message));
      else {
        const result = new File([data.buffer], data.name, {type: 'application/x-hdf5', lastModified: file.lastModified});
        cleanup();
        resolve({file: result, stats: data.stats});
      }
    };
    worker.postMessage({file});
  });
}
