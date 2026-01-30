"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { generateTrajectory, trajectory } = require("../cursory.js");

/**
 * @param {number} value - Value to assert.
 * @param {number} expected - Expected value.
 * @param {number} [epsilon=1e-6] - Allowed delta.
 */
function assertClose(value, expected, epsilon = 1e-6) {
  assert.ok(Number.isFinite(value), "Value should be finite.");
  assert.ok(Math.abs(value - expected) <= epsilon, `Expected ${value} to be within ${epsilon} of ${expected}.`);
}

test("trajectory returns a non-empty array with exact start/end", () => {
  const from = { x: 100, y: 100 };
  const to = { x: 600, y: 700 };

  const points = trajectory(from, to);

  assert.ok(Array.isArray(points), "trajectory should return an array.");
  assert.ok(points.length > 2, "trajectory should return multiple points.");
  assertClose(points[0].x, from.x);
  assertClose(points[0].y, from.y);
  assertClose(points[points.length - 1].x, to.x);
  assertClose(points[points.length - 1].y, to.y);
});

test("generateTrajectory returns timings aligned with points", () => {
  const from = { x: 50, y: 75 };
  const to = { x: 300, y: 450 };

  const { points, timings } = generateTrajectory(from, to, { frequency: 120, frequencyRandomizer: 2 });

  assert.ok(points.length > 2, "points should be populated.");
  assert.strictEqual(points.length, timings.length, "points and timings must have matching lengths.");
  assert.strictEqual(timings[0], 0, "timings should be normalized to start at 0.");
  for (let i = 1; i < timings.length; i += 1) {
    assert.ok(timings[i] >= timings[i - 1], "timings should be non-decreasing.");
  }
});

test("generateTrajectory validates input", () => {
  assert.throws(() => generateTrajectory({ x: 0, y: 0 }, { x: 1, y: 1 }, { frequency: 0 }), /frequency/);
  assert.throws(() => generateTrajectory({ x: 0, y: 0 }, { x: 1, y: 1 }, { frequencyRandomizer: -1 }), /frequencyRandomizer/);
  assert.throws(() => trajectory({ x: "bad", y: 0 }, { x: 1, y: 1 }), /x/);
});
