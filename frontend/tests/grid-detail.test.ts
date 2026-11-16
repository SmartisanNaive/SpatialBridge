import assert from 'node:assert/strict';
import test from 'node:test';
import {gridLineOpacity, selectGridDetail} from '../src/gridDetail.ts';
import {groupGridPoints} from '../src/gridGroups.ts';

test('group previews become readable before individual spots', () => {
  assert.equal(selectGridDetail(1), 'overview');
  assert.equal(selectGridDetail(1.9), 'overview');
  assert.equal(selectGridDetail(2), 'grid');
  assert.equal(selectGridDetail(9), 'grid');
  assert.equal(selectGridDetail(12), 'spots');
  assert.equal(selectGridDetail(24), 'spots');
});

test('small zoom reversals do not flicker groups or interactive markers', () => {
  assert.equal(selectGridDetail(1.9, 'grid'), 'grid');
  assert.equal(selectGridDetail(1.7, 'grid'), 'overview');
  assert.equal(selectGridDetail(11.5, 'spots'), 'spots');
  assert.equal(selectGridDetail(10.9, 'spots'), 'grid');
  assert.equal(selectGridDetail(1, 'spots'), 'overview');
  assert.equal(selectGridDetail(16, 'overview'), 'spots');
});

test('unknown or invalid cell geometry stays in overview', () => {
  for (const size of [0, -1, NaN, Infinity]) {
    assert.equal(selectGridDetail(size, 'spots'), 'overview');
  }
});

test('group outlines fade in as the four-cell span becomes readable', () => {
  assert.equal(gridLineOpacity(1), 0);
  assert.ok(gridLineOpacity(2) > 0 && gridLineOpacity(2) < .1);
  assert.ok(gridLineOpacity(3) > gridLineOpacity(2));
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

test('partial groups and missing coordinates do not manufacture sample points', () => {
  const base = {raster: 0, x: 10, y: 20, detected: false};
  const points = [{...base, spot_id: 1, original_x: -1, original_y: -1},
    {...base, spot_id: 2, original_x: 0, original_y: 0},
    {...base, spot_id: 3}, {...base, spot_id: 4}, {...base, spot_id: 5, x: NaN}];
  assert.deepEqual(groupGridPoints(points).map(group => group.map(p => p.spot_id)), [[1], [2], [3], [4]]);
});
