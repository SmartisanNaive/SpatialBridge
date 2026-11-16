import assert from 'node:assert/strict';
import test from 'node:test';
import {gridLineOpacity, selectGridDetail, selectGridGroupSide} from '../src/gridDetail.ts';
import {groupGridPoints} from '../src/gridGroups.ts';

test('group previews become readable before individual spots', () => {
  assert.equal(selectGridDetail(.4), 'overview');
  assert.equal(selectGridDetail(.49), 'overview');
  assert.equal(selectGridDetail(.5), 'grid');
  assert.equal(selectGridDetail(9), 'grid');
  assert.equal(selectGridDetail(12), 'spots');
  assert.equal(selectGridDetail(24), 'spots');
});

test('small zoom reversals do not flicker groups or interactive markers', () => {
  assert.equal(selectGridDetail(.48, 'grid'), 'grid');
  assert.equal(selectGridDetail(.44, 'grid'), 'overview');
  assert.equal(selectGridDetail(11.5, 'spots'), 'spots');
  assert.equal(selectGridDetail(10.9, 'spots'), 'grid');
  assert.equal(selectGridDetail(.4, 'spots'), 'overview');
  assert.equal(selectGridDetail(16, 'overview'), 'spots');
});

test('unknown or invalid cell geometry stays in overview', () => {
  for (const size of [0, -1, NaN, Infinity]) {
    assert.equal(selectGridDetail(size, 'spots'), 'overview');
  }
});

test('group outlines fade in at overview without fading again at density changes', () => {
  assert.equal(gridLineOpacity(.4), 0);
  assert.ok(gridLineOpacity(.5) > 0 && gridLineOpacity(.5) < .1);
  assert.ok(gridLineOpacity(.75) > gridLineOpacity(.5));
  assert.equal(gridLineOpacity(1), 1);
  assert.equal(gridLineOpacity(2), 1);
  assert.equal(gridLineOpacity(4), 1);
  assert.equal(gridLineOpacity(12), 1);
  assert.equal(gridLineOpacity(NaN), 0);
});

test('4 by 4 acquisition groups keep every point and remain separate across rasters', () => {
  const points = Array.from({length: 64}, (_, i) => ({spot_id: i, raster: 0,
    x: i, y: i, original_x: i % 8, original_y: Math.floor(i / 8), detected: true}));
  const groups = groupGridPoints(points);
  assert.equal(groups.length, 4);
  assert.ok(groups.every(group => group.length === 16));
  assert.equal(new Set(groups.flat()).size, 64);
  const extraRaster = {...points[0], raster: 1};
  const combined = groupGridPoints([...points, extraRaster]);
  assert.equal(combined.length, 5);
  assert.deepEqual(combined.at(-1), [extraRaster]);
  assert.deepEqual(groupGridPoints([...points].reverse()).map(g => g.map(p => p.spot_id).sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]),
    groups.map(g => g.map(p => p.spot_id)));
});

test('density follows projected cell size and keeps a dead band in both directions', () => {
  assert.equal(selectGridGroupSide(1), 16);
  assert.equal(selectGridGroupSide(2), 8);
  assert.equal(selectGridGroupSide(4), 4);
  assert.equal(selectGridGroupSide(1.9, 8), 8);
  assert.equal(selectGridGroupSide(1.79, 8), 16);
  assert.equal(selectGridGroupSide(3.8, 4), 4);
  assert.equal(selectGridGroupSide(3.59, 4), 8);
  assert.equal(selectGridGroupSide(1, 4), 16);
  assert.equal(selectGridGroupSide(8, 16), 4);
  assert.equal(selectGridGroupSide(NaN, 4), 16);
});

test('coarser levels nest complete smaller groups and reduce their count', () => {
  const points = Array.from({length: 1024}, (_, i) => ({spot_id: i, raster: 0,
    x: i, y: i, original_x: i % 32 - 16, original_y: Math.floor(i / 32) - 16, detected: true}));
  const levels = [4, 8, 16] as const;
  const groups = levels.map(side => groupGridPoints(points, side));
  assert.deepEqual(groups.map(g => g.length), [64, 16, 4]);
  groups.forEach((level, index) => {
    assert.ok(level.every(group => group.length === levels[index] ** 2));
    assert.equal(new Set(level.flat()).size, points.length);
    if (index > 0) {
      const membership = new Map(level.flatMap((g, i) => g.map(p => [p.spot_id, i] as const)));
      for (const smaller of groups[index - 1]) {
        assert.equal(new Set(smaller.map(p => membership.get(p.spot_id))).size, 1);
      }
    }
  });
});

test('partial groups and missing coordinates do not manufacture sample points', () => {
  const base = {raster: 0, x: 10, y: 20, detected: false};
  const points = [{...base, spot_id: 1, original_x: -1, original_y: -1},
    {...base, spot_id: 2, original_x: 0, original_y: 0},
    {...base, spot_id: 3}, {...base, spot_id: 4}, {...base, spot_id: 5, x: NaN}];
  assert.deepEqual(groupGridPoints(points).map(group => group.map(p => p.spot_id)), [[1], [2], [3], [4]]);
});
