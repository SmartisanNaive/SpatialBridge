// Version 1: eight magic bytes, uint32-le JSON length, UTF-8 manifest, raw arrays.
// No wall-clock fields or archive timestamps: regenerating a package is resumable.
export const SBD_MAGIC = 'SPBSBD01';
export const MAX_SBD_BYTES = 128 * 1024 * 1024;
export type SbdAttribute = {name: string; dtype: string; shape: number[]; values: string[]};
export type SbdGroup = {path: string; attrs: SbdAttribute[]};
export type SbdDataset = {
  path: string; dtype: string; shape: number[]; attrs: SbdAttribute[];
  offset?: number; length?: number; values?: string[];
};
export type SbdManifest = {
  format: 'sbd-extract'; version: 1; source: {name: string; size: number};
  groups: SbdGroup[]; datasets: SbdDataset[];
};

export function packSbd(manifest: SbdManifest, blocks: Uint8Array[]): ArrayBuffer {
  const metadata = new TextEncoder().encode(JSON.stringify(manifest));
  const size = 12 + metadata.byteLength + blocks.reduce((sum, block) => sum + block.byteLength, 0);
  if (metadata.byteLength > 4 * 1024 * 1024 || size > MAX_SBD_BYTES) throw new Error('SBD 所需数据超过本地提取的 128 MiB 限制');
  const output = new Uint8Array(size);
  output.set(new TextEncoder().encode(SBD_MAGIC));
  new DataView(output.buffer).setUint32(8, metadata.byteLength, true);
  output.set(metadata, 12);
  let offset = 12 + metadata.byteLength;
  for (const block of blocks) {output.set(block, offset); offset += block.byteLength;}
  return output.buffer;
}
