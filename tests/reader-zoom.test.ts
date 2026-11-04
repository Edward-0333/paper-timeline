import test from 'node:test';
import assert from 'node:assert/strict';
import { readerWheelZoom } from '../src/reader-zoom';

test('regular and large wheel events are bounded, symmetric and independent of the starting zoom range', () => {
  for (const current of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4.5]) {
    for (const [delta, mode] of [[100, 0], [120, 0], [1200, 0], [3, 1], [10, 1], [1, 2]]) {
      const down = readerWheelZoom(current, delta, mode), up = readerWheelZoom(current, -delta, mode);
      assert(Math.abs(current - down - 0.05) < 1e-9);
      assert(Math.abs(up - current - 0.05) < 1e-9);
      assert.equal(readerWheelZoom(down, -delta, mode), current);
      assert.equal(readerWheelZoom(up, delta, mode), current);
    }
  }
});
test('fine wheel movements remain fine and endpoints or invalid deltas never overshoot', () => {
  assert.equal(readerWheelZoom(1, 10, 0), 0.995);
  assert.equal(readerWheelZoom(1, -10, 0), 1.005);
  assert.equal(readerWheelZoom(0.11, 120, 0), 0.1);
  assert.equal(readerWheelZoom(4.99, -120, 0), 5);
  assert.equal(readerWheelZoom(0.1, 1200, 0), 0.1);
  assert.equal(readerWheelZoom(5, -1200, 0), 5);
  for (const delta of [0, Infinity, -Infinity, NaN]) assert.equal(readerWheelZoom(1, delta, 0), 1);
});
