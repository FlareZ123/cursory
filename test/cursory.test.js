"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { trajectory, trajectoryWithTimings, _internal } = require("../cursory.js");

/**
 * Deterministic RNG for tests.
 * @param {number} seed - Initial seed.
 * @returns {() => number}
 */
function createDeterministicRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("trajectory returns points with correct endpoints", () => {
  const rng = createDeterministicRng(12345);
  const start = { x: 100, y: 100 };
  const end = { x: 600, y: 700 };

  const points = trajectory(start, end, { random: rng, frequencyRandomizer: 1, frequency: 60 });

  assert.ok(Array.isArray(points));
  assert.ok(points.length > 2);
  assert.deepEqual(points[0], start);
  assert.deepEqual(points[points.length - 1], end);

  for (const point of points) {
    assert.ok(Number.isFinite(point.x));
    assert.ok(Number.isFinite(point.y));
  }
});

test("trajectoryWithTimings returns aligned points and timings", () => {
  const rng = createDeterministicRng(99);
  const start = { x: 0, y: 0 };
  const end = { x: 10, y: 10 };

  const result = trajectoryWithTimings(start, end, { random: rng, frequency: 30, frequencyRandomizer: 2 });

  assert.ok(result.points.length > 0);
  assert.equal(result.points.length, result.timings.length);
  assert.deepEqual(result.points[0], start);
  assert.deepEqual(result.points[result.points.length - 1], end);

  for (let i = 1; i < result.timings.length; i += 1) {
    assert.ok(result.timings[i] >= result.timings[i - 1]);
  }
});

test("findNearestTrajectory picks shortest paths for zero-length target", () => {
  const state = _internal.loadTrajectories();
  const rng = createDeterministicRng(1);
  const target = { x: 1, y: 1 };
  const topN = 3;

  const nearest = _internal.findNearestTrajectory(target, target, { topN, random: rng });
  assert.equal(nearest.length, topN);

  const sortedLengths = [...state.trajectoryLengths].sort((a, b) => a - b).slice(0, topN);
  const nearestLengths = nearest.map((traj) => traj.length).sort((a, b) => a - b);

  assert.deepEqual(nearestLengths, sortedLengths);
});

test("generateMiddleBiasedPoint stays within bounds", () => {
  const rng = createDeterministicRng(42);
  const [x, y] = _internal.generateMiddleBiasedPoint(0, 0, 10, 20, { random: rng });

  assert.ok(x >= 0 && x <= 10);
  assert.ok(y >= 0 && y <= 20);
});

test("jitterTrajectory preserves length and shape", () => {
  const rng = createDeterministicRng(7);
  const points = [
    [0, 0],
    [5, 5],
    [10, 10],
  ];

  const jittered = _internal.jitterTrajectory(points, 14.1, { random: rng, scale: 0.05 });

  assert.equal(jittered.length, points.length);
  assert.ok(jittered.some((point, index) => point[0] !== points[index][0] || point[1] !== points[index][1]));
});

test("weightedChoice uses weights deterministically", () => {
  const rng = createDeterministicRng(5);
  const weights = [0.1, 0.2, 0.7];

  const selection = _internal.weightedChoice(rng, weights);

  assert.ok(selection >= 0 && selection < weights.length);
});

test("trajectory validates input", () => {
  assert.throws(() => trajectory({ x: 0, y: NaN }, { x: 1, y: 2 }));
  assert.throws(() => trajectory({ x: 0, y: 1 }, { x: 1, y: Infinity }));
  assert.throws(() => trajectory(null, { x: 1, y: 2 }));
});
