const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const blockSize = 1024 * 1024;
const maxDecodedBytes = 1024 * 1024 * 1024;
export type PngResult = {blob?: Blob; reason: 'optimized' | 'compressed' | 'unchanged' | 'unsupported'};

const crcTable = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(kind: string, bytes: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(bytes.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, bytes.length);
  result.set(new TextEncoder().encode(kind), 4);
  result.set(bytes, 8);
  view.setUint32(bytes.length + 8, pngCrc(result.subarray(4, bytes.length + 8)));
  return result.buffer;
}

export async function readPngDimensions(file: Blob): Promise<{width: number; height: number} | null> {
  try {
    const slice = await file.slice(0, 32).arrayBuffer();
    if (slice.byteLength < 24) return null;
    const view = new DataView(slice);
    if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;
    if (view.getUint32(12) !== 0x49484452) return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return {width, height};
  } catch {
    return null;
  }
}

/** Recompress the filtered scanlines, preserving their bytes and every non-IDAT chunk.
 * No canvas, pixel conversion, or full decoded-image buffer is used.
 */
export async function optimizePngData(file: Blob, progress: (bytes: number) => void = () => {}): Promise<PngResult> {
  const original = {reason: 'unchanged'} as const;
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') return {reason: 'unsupported'};
  const header = new Uint8Array(await file.slice(0, 33).arrayBuffer());
  if (header.length !== 33 || !signature.every((byte, i) => header[i] === byte) ||
      new TextDecoder().decode(header.subarray(12, 16)) !== 'IHDR' || new DataView(header.buffer).getUint32(8) !== 13) return original;
  const ranges: {start: number; end: number}[] = [];
  let first = -1;
  let last = -1;
  let ended = false;
  let complete = false;
  let offset = 33;
  let chunks = 0;
  while (offset + 12 <= file.size && ++chunks <= 100000) {
    const bytes = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
    const length = new DataView(bytes.buffer).getUint32(0);
    const kind = new TextDecoder().decode(bytes.subarray(4));
    const end = offset + length + 12;
    if (end > file.size) return original;
    if (kind === 'IDAT') {
      if (ended) return original; // IDAT chunks must be consecutive.
      if (first < 0) {
        if (length < 2) return original;
        const zlib = new Uint8Array(await file.slice(offset + 8, offset + 10).arrayBuffer());
        if ((zlib[0] & 15) !== 8 || ((zlib[0] << 8) + zlib[1]) % 31 || (zlib[1] & 32)) return original;
        // The zlib level is a hint. Conservatively skip default/high compression:
        // native CompressionStream cannot select a stronger compression level.
        if (zlib[1] >>> 6 >= 2) return {reason: 'compressed'};
        first = offset;
      }
      ranges.push({start: offset + 8, end: offset + 8 + length});
      last = end;
    } else if (first >= 0) ended = true;
    if (kind === 'IEND') {
      if (length !== 0 || end !== file.size) return original;
      complete = true;
      break;
    }
    offset = end;
  }
  if (first < 0 || !ended || !complete) return original;

  const compressedInput = new Blob(ranges.map(({start, end}) => file.slice(start, end)));
  const decoded = compressedInput.stream().pipeThrough(new DecompressionStream('deflate'));
  let decodedBytes = 0;
  // Bound decoded data even if dimensions or compressed input are malformed.
  const bounded = decoded.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(bytes, controller) {
      decodedBytes += bytes.length;
      if (decodedBytes > maxDecodedBytes) throw new Error('PNG decoded size exceeds local optimization limit');
      controller.enqueue(bytes);
    },
  }));
  const reader = bounded.pipeThrough(new CompressionStream('deflate')).getReader();
  const parts: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size >= Math.min(file.size * 0.97, 128 * 1024 * 1024)) {
        await reader.cancel();
        return original;
      }
      parts.push(value.slice().buffer as ArrayBuffer);
      progress(decodedBytes);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return original;
  } finally {
    reader.releaseLock();
  }
  const payload = new Blob(parts);
  parts.length = 0;
  const output: BlobPart[] = [file.slice(0, first)];
  // Fixed output chunk boundaries keep PNG framing deterministic for resumption.
  for (let start = 0; start < payload.size; start += blockSize) {
    output.push(pngChunk('IDAT', new Uint8Array(await payload.slice(start, start + blockSize).arrayBuffer())));
  }
  output.push(file.slice(last));
  const blob = new Blob(output, {type: 'image/png'});
  return file.size - blob.size >= Math.max(1024, file.size * 0.03) ? {blob, reason: 'optimized'} : original;
}
