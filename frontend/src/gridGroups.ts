import type {GridPoint} from './types';

export const GRID_GROUP_SIDE = 4;

// Acquisition coordinates, partitioned by raster, keep groups stable when panning.
// Missing acquisition coordinates remain separate rather than merging unrelated spots.
export function groupGridPoints(points: GridPoint[]): GridPoint[][] {
  const groups = new Map<string, GridPoint[]>();
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const {original_x: x, original_y: y} = point;
    const key = x != null && y != null && Number.isFinite(x) && Number.isFinite(y)
      ? `${point.raster}:${Math.floor(x / GRID_GROUP_SIDE)}:${Math.floor(y / GRID_GROUP_SIDE)}`
      : `spot:${point.raster}:${point.spot_id}`;
    const group = groups.get(key);
    if (group) group.push(point);
    else groups.set(key, [point]);
  }
  return [...groups.values()];
}
