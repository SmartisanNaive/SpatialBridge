import assert from 'node:assert/strict';
import test from 'node:test';
import {POINTER_CLICK_TOLERANCE_PX, PointerGesture} from '../src/pointerGesture.ts';

const start = (gesture: PointerGesture, pointerId = 1) => {
  gesture.begin({pointerId, clientX: 100, clientY: 100, button: 0});
};

test('a stationary pointer and movement inside the tolerance remain a click', () => {
  const gesture = new PointerGesture();
  start(gesture);
  gesture.move({pointerId: 1, clientX: 100 + POINTER_CLICK_TOLERANCE_PX, clientY: 100});
  gesture.end(1);

  assert.equal(gesture.consumeClick(), false);
});

test('movement past the tolerance suppresses the click even after returning to the start', () => {
  const gesture = new PointerGesture();
  start(gesture);
  gesture.move({pointerId: 1, clientX: 106, clientY: 100});
  gesture.move({pointerId: 1, clientX: 100, clientY: 100});
  gesture.end(1);

  assert.equal(gesture.shouldSuppressClick(), true);
  assert.equal(gesture.consumeClick(), true);
  assert.equal(gesture.shouldSuppressClick(), false);
});

test('the next independent pointerdown resets suppression left by a drag', () => {
  const gesture = new PointerGesture();
  start(gesture, 1);
  gesture.move({pointerId: 1, clientX: 107, clientY: 100});
  gesture.end(1);
  assert.equal(gesture.shouldSuppressClick(), true);

  start(gesture, 2);
  gesture.end(2);
  assert.equal(gesture.consumeClick(), false);
});

test('ending outside the canvas clears the active pointer without creating a false selection', () => {
  const gesture = new PointerGesture();
  start(gesture);
  gesture.move({pointerId: 1, clientX: 160, clientY: 100});
  gesture.end(1);

  assert.equal(gesture.activePointerCount, 0);
  assert.equal(gesture.consumeClick(), true);
});

test('cancel and window blur suppress the abandoned interaction', () => {
  const canceled = new PointerGesture();
  start(canceled);
  canceled.cancel(1);
  assert.equal(canceled.consumeClick(), true);

  const blurred = new PointerGesture();
  start(blurred);
  blurred.cancelAll();
  assert.equal(blurred.activePointerCount, 0);
  assert.equal(blurred.consumeClick(), true);
});

test('a second pointer suppresses the whole multi-touch sequence', () => {
  const gesture = new PointerGesture();
  start(gesture, 1);
  gesture.begin({pointerId: 2, clientX: 200, clientY: 200, button: 0});
  gesture.end(1);
  gesture.end(2);

  assert.equal(gesture.consumeClick(), true);
  start(gesture, 3);
  gesture.end(3);
  assert.equal(gesture.consumeClick(), false);
});

test('non-primary buttons do not start a selection gesture', () => {
  const gesture = new PointerGesture();
  gesture.begin({pointerId: 1, clientX: 100, clientY: 100, button: 2});

  assert.equal(gesture.activePointerCount, 0);
  assert.equal(gesture.consumeClick(), false);
});
