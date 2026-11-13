// Lossless transport compression for upload chunks.
//
// Microscopy PNGs are already compressed and gain nothing, while SBD data and
// some TIFFs shrink noticeably. Compressing costs CPU time, so a chunk is only
// compressed when the bytes saved are worth more than the time spent.

export type CompressionSample = {
  /** Compressed size divided by original size for the most recent attempt. */
  ratio: number;
  compressBytesPerSecond: number;
  networkBytesPerSecond: number;
};

/** Chunks that shrink by less than this are sent as they are. */
export const MIN_USEFUL_SAVING = 0.05;

export function compressionSupported(): boolean {
  return typeof CompressionStream === 'function';
}

export async function gzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Decide whether compressing the next chunk of a file is expected to make the
 * upload faster, given what the previous chunks of that file showed.
 */
export function shouldCompress(sample: CompressionSample | null): boolean {
  if (!sample) return true;
  const {ratio, compressBytesPerSecond, networkBytesPerSecond} = sample;
  if (!Number.isFinite(ratio) || ratio > 1 - MIN_USEFUL_SAVING) return false;
  if (!(compressBytesPerSecond > 0) || !(networkBytesPerSecond > 0)) return true;
  // Seconds per original byte: compress then send the smaller payload, versus
  // sending the original payload.
  return 1 / compressBytesPerSecond + ratio / networkBytesPerSecond < 1 / networkBytesPerSecond;
}
