import assert from 'node:assert/strict';
import test from 'node:test';
import {gridLineOpacity, selectGridDetail} from '../src/gridDetail.ts';

test('cell visibility follows CSS pixel size at overview, grid and inspection scales', () => {
  assert.equal(selectGridDetail(2), 'overview');
  assert.equal(selectGridDetail(5.9), 'overview');
  assert.equal(selectGridDetail(6), 'grid');
  assert.equal(selectGridDetail(9), 'grid');
  assert.equal(selectGridDetail(12), 'spots');
  assert.equal(selectGridDetail(24), 'spots');
});

test('small zoom reversals do not flicker cells or interactive markers', () => {
  assert.equal(selectGridDetail(5.8, 'grid'), 'grid');
  assert.equal(selectGridDetail(5.4, 'grid'), 'overview');
  assert.equal(selectGridDetail(11.5, 'spots'), 'spots');
  assert.equal(selectGridDetail(10.9, 'spots'), 'grid');
  assert.equal(selectGridDetail(2, 'spots'), 'overview');
  assert.equal(selectGridDetail(16, 'overview'), 'spots');
});

test('unknown or invalid cell geometry stays in overview', () => {
  for (const size of [0, -1, NaN, Infinity]) {
    assert.equal(selectGridDetail(size, 'spots'), 'overview');
  }
});

test('grid lines fade in without overpowering the overview', () => {
  assert.equal(gridLineOpacity(2), 0);
  assert.ok(gridLineOpacity(6) > 0 && gridLineOpacity(6) < .1);
  assert.ok(gridLineOpacity(9) > gridLineOpacity(6));
  assert.equal(gridLineOpacity(12), 1);
  assert.equal(gridLineOpacity(24), 1);
  assert.equal(gridLineOpacity(NaN), 0);
});
