export type GridDetail = 'overview' | 'grid' | 'spots';

// CSS pixels, independent of image dimensions, zoom labels and display density.
export const GRID_VISIBLE_PX = 2;
export const SPOT_INTERACTIVE_PX = 12;

export function selectGridDetail(side: number, previous: GridDetail = 'overview'): GridDetail {
  if (!Number.isFinite(side) || side <= 0) return 'overview';
  if (side >= SPOT_INTERACTIVE_PX || (previous === 'spots' && side >= 11)) return 'spots';
  if (side >= GRID_VISIBLE_PX || (previous !== 'overview' && side >= 1.8)) return 'grid';
  return 'overview';
}

export function gridLineOpacity(side: number): number {
  if (!Number.isFinite(side)) return 0;
  return Math.max(0, Math.min(1, (side - 1.8) / (GRID_VISIBLE_PX * 2 - 1.8)));
}
