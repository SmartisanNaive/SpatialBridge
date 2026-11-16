export type GridDetail = 'overview' | 'grid' | 'spots';
export type GridGroupSide = 4 | 8 | 16;

// CSS pixels, independent of image dimensions, zoom labels and display density.
export const GRID_VISIBLE_PX = .5;
export const SPOT_INTERACTIVE_PX = 12;

export function selectGridDetail(side: number, previous: GridDetail = 'overview'): GridDetail {
  if (!Number.isFinite(side) || side <= 0) return 'overview';
  if (side >= SPOT_INTERACTIVE_PX || (previous === 'spots' && side >= 11)) return 'spots';
  if (side >= GRID_VISIBLE_PX || (previous !== 'overview' && side >= .45)) return 'grid';
  return 'overview';
}

// Nested acquisition blocks keep their boundaries aligned across levels.
// A 10% dead band prevents repeated density changes near a threshold.
export function selectGridGroupSide(side: number, previous: GridGroupSide = 16): GridGroupSide {
  if (!Number.isFinite(side) || side <= 0) return 16;
  if (side >= 4 || (previous === 4 && side >= 3.6)) return 4;
  if (side >= 2 || (previous !== 16 && side >= 1.8)) return 8;
  return 16;
}

export function gridLineOpacity(side: number): number {
  if (!Number.isFinite(side)) return 0;
  return Math.max(0, Math.min(1, (side * 16 - 7.2) / 8.8));
}
