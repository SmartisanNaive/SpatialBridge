import type {CoordinateModel, SavedViewResponse, ManualPoint, HeatmapInfo, FramePoint} from './types';
import {apiUrl} from './api';

export function heatmapOrientation(info: HeatmapInfo): string {
  if (info.rotation_degrees == null || info.mirrored == null) return '';
  const angle = ((info.rotation_degrees % 360) + 360) % 360;
  if (info.mirrored && Math.abs(angle - 180) < 2) return '相对参考图主要为上下翻转';
  if (info.mirrored && (angle < 2 || angle > 358)) return '相对参考图主要为左右翻转';
  return `相对参考图${info.mirrored ? '镜像后' : ''}旋转 ${info.rotation_degrees}°`;
}

export function spotNumber(value: number | null | undefined, digits = 3) {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

export function sanitizeManualPoints(value: unknown): ManualPoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter((point): point is ManualPoint => {
    if (!point || typeof point !== 'object') return false;
    const item = point as Partial<ManualPoint>;
    return typeof item.id === 'string' && Number.isFinite(item.x) && Number.isFinite(item.y) &&
      (item.value === undefined || Number.isFinite(item.value));
  });
}

export function manualPointsFromView(view: SavedViewResponse | null | undefined) {
  if (!view) return [];
  const legacy = (view as SavedViewResponse & {manualPoints?: unknown}).manualPoints;
  return sanitizeManualPoints(view.viewport?.manualPoints ?? legacy);
}

export function newManualPointId() {
  return `point-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function evaluateCoordinateModel(model: CoordinateModel, worldX: number, worldY: number) {
  const center = model.normalization?.center;
  const scale = model.normalization?.scale;
  const coefficients = model.coefficients;
  if (!center || !scale || !coefficients || !Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;
  const domain = model.footprint_domain?.world ?? model.valid_domain?.world;
  if (domain && (worldX < domain[0] || worldX > domain[2] || worldY < domain[1] || worldY > domain[3])) return null;
  const x = (worldX - center[0]) / Math.max(Math.abs(scale[0]), 1e-9);
  const y = (worldY - center[1]) / Math.max(Math.abs(scale[1]), 1e-9);
  const terms = model.term_order ?? (model.degree === 3
    ? ['1', 'x', 'y', 'x2', 'xy', 'y2', 'x3', 'x2y', 'xy2', 'y3']
    : model.degree === 2 ? ['1', 'x', 'y', 'x2', 'xy', 'y2'] : ['1', 'x', 'y']);
  const values: Record<string, number> = {
    '1': 1, x, y, x2: x * x, xy: x * y, y2: y * y,
    x3: x * x * x, x2y: x * x * y, xy2: x * y * y, y3: y * y * y,
  };
  if (coefficients.length !== terms.length || coefficients.some((row) => row.length < 2)) return null;
  const result: [number, number] = [0, 0];
  terms.forEach((term, index) => {
    result[0] += values[term] * coefficients[index][0];
    result[1] += values[term] * coefficients[index][1];
  });
  return Number.isFinite(result[0]) && Number.isFinite(result[1]) ? {x: result[0], y: result[1]} : null;
}

export const GRID_INDEX_BUCKET_SIZE = 1024;

export function convexHull(points: FramePoint[]): FramePoint[] {
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice()
    .sort((first, second) => first.x - second.x || first.y - second.y);
  const unique: FramePoint[] = [];
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) unique.push(point);
  }
  if (unique.length <= 2) return unique;
  const cross = (origin: FramePoint, first: FramePoint, second: FramePoint) =>
    (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
  const lower: FramePoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: FramePoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function projectPoint(matrix: number[][], x: number, y: number): FramePoint | null {
  if (matrix.length !== 3 || matrix.some((row) => row.length !== 3 || row.some((value) => !Number.isFinite(value)))) return null;
  const denominator = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
  const projectedX = (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]) / denominator;
  const projectedY = (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]) / denominator;
  return Number.isFinite(projectedX) && Number.isFinite(projectedY) ? {x: projectedX, y: projectedY} : null;
}

export function makeTileSource(projectId: string, layer: string, width: number, height: number) {
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)));
  return {
    width,
    height,
    tileSize: 256,
    minLevel: 0,
    maxLevel,
    getTileUrl: (level: number, x: number, y: number) =>
      `${apiUrl(`/projects/${projectId}/layers/${layer}/tiles/${level}/${x}/${y}.png`)}?v=5`,
  };
}

export function methodLabel(method: string) {
  if (method === 'reference identity') return '参考图层（原始坐标）';
  if (method === 'two-marker similarity') return '双锚点相似变换';
  if (method === 'two-marker homography') return '双锚点方框透视变换';
  return method;
}

export function limitationLabel(value: string) {
  if (/heatmap|热图/i.test(value)) return '本次视图聚焦采集前/采集后显微图及空间配准结果。';
  const labels: Record<string, string> = {
    'Regional alignment only; no cell-scale accuracy claim.': '当前为区域级配准，不承诺细胞尺度精度。',
    'Marker corners validate the end anchors; central area lacks independent optical evidence.': '端部标记角点已验证；中央区域缺少独立光学证据。',
    'Microscopy TIFF files and SBD are not read.': '不会读取显微 TIFF、SBD 或原始数据文件。',
    '当前为区域级前后图像对齐，不承诺细胞尺度精度。': '当前为区域级前后图像对齐，不承诺细胞尺度精度。',
    '灼烧坑上的数值由用户人工录入，单独保存，不会改写原始 SBD。': '灼烧坑数值可来自 SBD normalization 字段；人工赋值单独保存，不改写原始 SBD。',
    '导入时仅读取 SBD 的索引和汇总信息，不加载完整原始光谱。': '导入时仅读取 SBD 的索引和汇总信息，不加载完整原始光谱。',
    'SBD raster 0 的坐标链已通过板图→热图→显微图和 OriginalCoordinates 一致性验证。': 'SBD raster 0 的坐标链已通过 OriginalCoordinates 一致性验证。',
    'raster 1/2 位于当前显微 PNG 覆盖范围外，保持未映射，不强行投影。': 'raster 1/2 位于当前显微 PNG 覆盖范围外，保持未映射，不强行投影。',
    '灼烧坑检测以 SBD 采集网格为候选，并用采集后显微图的局部方坑响应进行确认。': '灼烧坑检测以 SBD 采集网格为候选，并用采集后显微图的局部方坑响应进行确认。',
    '自动值来自所选 SBD normalization 字段；人工赋值单独保存，不会改写原始 SBD。': '自动值来自所选 SBD normalization 字段；人工赋值单独保存，不改写原始 SBD。',
    '导入时读取 SBD 坐标和 normalization 数值，不加载完整原始光谱。': '导入时读取 SBD 坐标和 normalization 数值，不加载完整原始光谱。',
    '灼烧坑检测先从全幅清晰方坑恢复相邻行列，再用 SpaceM 的尺度化局部响应确认节点；模糊区域保留网格候选，不逐点改写 20 μm 方框。': '灼烧坑检测先从全幅清晰方坑恢复相邻行列，再用 SpaceM 的尺度化局部响应确认节点；模糊区域保留网格候选，不逐点改写 20 μm 方框。',
    '矩阵坐标链可回算，但全幅图像身份/几何验证未通过，当前结果需复核。': '矩阵坐标链可回算，但全幅图像身份/几何验证未通过，当前结果需复核。',
  };
  return labels[value] ?? value;
}
