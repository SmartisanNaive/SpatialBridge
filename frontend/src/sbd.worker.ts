import h5wasm from 'h5wasm';
import type {Attribute, Dataset, Group} from 'h5wasm';
import {sha256Hex} from './hash';
import {MAX_SBD_BYTES, packSbd} from './sbd-package';
import type {SbdAttribute, SbdDataset, SbdManifest} from './sbd-package';

const scope = self as unknown as {onmessage: ((event: MessageEvent<{file: File}>) => void) | null; postMessage: (value: unknown, transfer?: Transferable[]) => void};
const numericTypes: Record<string, string> = {
  '<b': 'int8', '<B': 'uint8', '<h': 'int16', '<H': 'uint16', '<i': 'int32', '<I': 'uint32',
  '<q': 'int64', '<Q': 'uint64', '<f': 'float32', '<d': 'float64',
};
const targets = ['Registrations/0', 'MeasurementRasterIndices', 'SpectraGroup/Normalizations', 'OpticalImages'];

function dtype(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SBD 字段包含不支持的复合类型或引用');
  const numeric = numericTypes[value.startsWith('|') ? '<' + value.slice(1) : value];
  if (numeric) return numeric;
  if (/^[|<>=]?[AS]\d*$/.test(value)) return 'string';
  throw new Error(`SBD 字段包含不支持的数据类型：${value}`);
}

function values(value: unknown): string[] {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value as unknown as ArrayLike<number | bigint>, String);
  if (Array.isArray(value)) return value.flatMap(values);
  if (['string', 'number', 'bigint', 'boolean'].includes(typeof value)) return [String(value)];
  throw new Error('SBD 字段包含不支持的空值或引用');
}

function attributes(entity: Group | Dataset): SbdAttribute[] {
  const attrs = entity.attrs;
  return Object.keys(attrs).sort().map((name) => {
    const attribute: Attribute = attrs[name];
    if (attribute.shape === null) throw new Error(`SBD 属性为空：${name}`);
    const type = dtype(attribute.dtype);
    const count = attribute.shape.reduce((a, b) => a * b, 1);
    if (!Number.isSafeInteger(count) || count > 65536 || (attribute.metadata.size ?? 0) * count > 1024 * 1024) throw new Error(`SBD 属性超出大小限制：${name}`);
    return {name, dtype: type, shape: attribute.shape, values: values(attribute.value)};
  });
}

scope.onmessage = async ({data: {file}}) => {
  let input: InstanceType<typeof h5wasm.File> | undefined;
  let mounted = false;
  let release = () => {};
  const stats = {sourceBytes: file.size, outputBytes: 0, readBytes: 0, maxReadBytes: 0, maxReadOffset: 0, wasmBytes: 0};
  const progress = (stage: string, completed: number, total: number) => scope.postMessage({type: 'progress', progress: {stage, completed, total}});
  try {
    const M = await h5wasm.ready;
    const FS = M.FS;
    release = () => {if (mounted) FS.unmount('/input');};
    M.activate_throwing_error_handler();
    // WORKERFS uses FileReaderSync + Blob.slice. Bound each temporary read to 4 MiB.
    const ops = (FS.filesystems.WORKERFS as unknown as {stream_ops: {read: (stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number) => number}}).stream_ops;
    const read = ops.read;
    ops.read = (stream, buffer, offset, length, position) => {
      let done = 0;
      while (done < length) {
        const requested = Math.min(4 * 1024 * 1024, length - done);
        const count = read(stream, buffer, offset + done, requested, position + done);
        stats.readBytes += count;
        stats.maxReadBytes = Math.max(stats.maxReadBytes, count);
        stats.maxReadOffset = Math.max(stats.maxReadOffset, position + done + count);
        done += count;
        if (count < requested) break;
      }
      return done;
    };
    FS.mkdir('/input');
    FS.mount(FS.filesystems.WORKERFS, {blobs: [{name: 'source.sbd', data: file}]}, '/input');
    mounted = true;
    progress('正在解析 SBD 目录结构…', 0, targets.length);
    input = new h5wasm.File('/input/source.sbd', 'r');
    const manifest: SbdManifest = {format: 'sbd-extract', version: 1, source: {name: file.name, size: file.size}, groups: [], datasets: []};
    const datasets: Array<{path: string; entity: Dataset}> = [];
    const addGroup = (path: string, group: Group) => {
      manifest.groups.push({path, attrs: attributes(group)});
      for (const key of group.keys().sort()) visit(path ? `${path}/${key}` : key, group.get(key));
    };
    const visit = (path: string, entity: unknown) => {
      if (datasets.length + manifest.groups.length > 4096) throw new Error('SBD 数据分组超出数量上限');
      if (entity instanceof h5wasm.Dataset) datasets.push({path, entity});
      else if (entity instanceof h5wasm.Group) addGroup(path, entity);
      else throw new Error(`SBD 数据格式不符合规范：${path}`);
    };
    // Only these subtrees are traversed. The raw spectra arrays are never opened.
    manifest.groups.push({path: '', attrs: attributes(input)});
    for (const parent of ['Registrations', 'SpectraGroup']) {
      const group = input.get(parent);
      if (group instanceof h5wasm.Group) manifest.groups.push({path: parent, attrs: attributes(group)});
    }
    for (const path of targets) {
      const entity = input.get(path);
      if (entity) visit(path, entity);
      else if (!path.endsWith('Normalizations')) throw new Error(`SBD 缺少必要的数据节点：${path}`);
    }
    const blocks: Uint8Array[] = [];
    let byteOffset = 0;
    for (const [index, {path, entity}] of datasets.entries()) {
      const type = dtype(entity.dtype);
      const shape = entity.shape;
      if (shape === null) throw new Error(`SBD 数据集为空：${path}`);
      const count = shape.reduce((a, b) => a * b, 1);
      if (!Number.isSafeInteger(count) || count < 0 || count * (entity.metadata.size || 8) > MAX_SBD_BYTES - byteOffset) throw new Error(`SBD 数据集大小超出限制：${path}`);
      const chunkBytes = entity.metadata.chunks?.reduce((a, b) => a * b, entity.metadata.size) ?? 0;
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes > 32 * 1024 * 1024 || entity.metadata.virtual_sources?.length) throw new Error(`SBD 数据分块过大或包含外部虚拟数据：${path}`);
      const unsupported = entity.filters.find((filter) => filter.id > 6);
      if (unsupported) throw new Error(`SBD 字段 ${path} 使用了不支持的压缩方式（${unsupported.id}）`);
      progress(`正在提取 SBD 数据（${index + 1}/${datasets.length}）…`, index, datasets.length);
      const item: SbdDataset = {path, dtype: type, shape, attrs: attributes(entity)};
      const data = entity.value;
      if (type === 'string') item.values = values(data);
      else if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
        const block = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        item.offset = byteOffset;
        item.length = block.byteLength;
        byteOffset += block.byteLength;
        if (byteOffset > MAX_SBD_BYTES) throw new Error('SBD 提取数据超出 128 MB 限制');
        blocks.push(block);
      } else throw new Error(`无法读取 SBD 数值：${path}`);
      manifest.datasets.push(item);
      stats.wasmBytes = Math.max(stats.wasmBytes, M.HEAPU8.buffer.byteLength);
    }
    input.close(); input = undefined;
    FS.unmount('/input'); mounted = false;
    progress('正在校验提取的数据…', datasets.length, datasets.length);
    const buffer = packSbd(manifest, blocks);
    const hash = await sha256Hex(buffer);
    const stem = file.name.replace(/\.sbd$/i, '');
    stats.outputBytes = buffer.byteLength;
    scope.postMessage({type: 'done', buffer, name: `${stem}.spatialbridge-${hash.slice(0, 16)}.sbdx`, stats}, [buffer]);
  } catch (error) {
    scope.postMessage({type: 'error', message: `SBD 数据提取失败：${error instanceof Error ? error.message : String(error)}（未上传原始文件）。`});
  } finally {
    try {input?.close();} finally {release();}
  }
};
