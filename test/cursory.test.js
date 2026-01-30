"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { trajectory, _internals } = require("../cursory.js");

/**
 * @param {number} seed
 * @returns {() => number}
 */
function makeRng(seed = 1) {
  let value = seed;
  return () => {
    value = (value * 48271) % 0x7fffffff;
    return value / 0x7fffffff;
  };
}

/**
 * @param {{x:number,y:number}} point
 * @param {{x:number,y:number}} expected
 */
function assertPointClose(point, expected) {
  assert.ok(Number.isFinite(point.x));
  assert.ok(Number.isFinite(point.y));
  assert.ok(Math.abs(point.x - expected.x) < 1e-6);
  assert.ok(Math.abs(point.y - expected.y) < 1e-6);
}

test("loadTrajectories returns cached dataset", () => {
  const { trajectories, dx, dy, lengths } = _internals.loadTrajectories();
  assert.ok(Array.isArray(trajectories));
  assert.ok(trajectories.length > 0);
  assert.equal(dx.length, trajectories.length);
  assert.equal(dy.length, trajectories.length);
  assert.equal(lengths.length, trajectories.length);
});

test("trajectory returns points matching start/end", () => {
  const rng = makeRng(42);
  const from = { x: 100, y: 100 };
  const to = { x: 600, y: 700 };
  const points = trajectory(from, to, { rng });
  assert.ok(Array.isArray(points));
  assert.ok(points.length > 2);
  assertPointClose(points[0], from);
  assertPointClose(points[points.length - 1], to);
});

test("trajectory can return timings", () => {
  const rng = makeRng(7);
  const from = { x: 50, y: 25 };
  const to = { x: 90, y: 120 };
  const result = trajectory(from, to, { rng, returnTimings: true });
  assert.ok(result && typeof result === "object");
  assert.ok(Array.isArray(result.points));
  assert.ok(Array.isArray(result.timings));
  assert.equal(result.points.length, result.timings.length);
  assertPointClose(result.points[0], from);
  assertPointClose(result.points[result.points.length - 1], to);
  for (let i = 1; i < result.timings.length; i += 1) {
    assert.ok(result.timings[i] >= result.timings[i - 1]);
  }
});

test("trajectory validates inputs", () => {
  assert.throws(() => trajectory({ x: "bad", y: 0 }, { x: 1, y: 2 }), /from\.x/);
  assert.throws(() => trajectory({ x: 0, y: 0 }, { x: 1, y: 2 }, { frequency: 0 }), /frequency/);
  assert.throws(
    () => _internals.generateTrajectory([0, 0], [1, 2], 1, -1, makeRng(3)),
    /frequencyRandomizer/,
  );
});

test("findNearestTrajectory returns requested count", () => {
  const list = _internals.findNearestTrajectory([0, 0], [100, 50], 0.8, 0.2, 3);
  assert.equal(list.length, 3);
});

test("findClosestTrajectory returns a trajectory and metrics", () => {
  const rng = makeRng(10);
  const result = _internals.findClosestTrajectory([0, 0], [10, 10], 3, 2, 2, rng);
  assert.ok(result.trajectory);
  assert.ok(Number.isFinite(result.dxTarget));
  assert.ok(Number.isFinite(result.dyTarget));
  assert.ok(Number.isFinite(result.lengthTarget));
});

test("morphTrajectory preserves endpoints", () => {
  const points = [
    [0, 0],
    [1, 1],
    [2, 2],
  ];
  const morphed = _internals.morphTrajectory(points, [10, 10], [20, 30], 10, 20, Math.hypot(10, 20));
  assert.deepEqual(morphed[0], [10, 10]);
  assert.deepEqual(morphed[morphed.length - 1], [20, 30]);
});

test("jitterTrajectory changes points while keeping length", () => {
  const rng = makeRng(5);
  const points = [
    [0, 0],
    [10, 0],
    [20, 0],
  ];
  const jittered = _internals.jitterTrajectory(points, 20, 0.5, rng);
  assert.equal(jittered.length, points.length);
  assert.notDeepEqual(jittered, points);
});

test("generateMiddleBiasedPoint stays within bounds", () => {
  const rng = makeRng(2);
  const point = _internals.generateMiddleBiasedPoint(0, 0, 10, 20, 2, rng);
  assert.ok(point[0] >= 0 && point[0] <= 10);
  assert.ok(point[1] >= 0 && point[1] <= 20);
});

test("knotTrajectory returns same number of points", () => {
  const rng = makeRng(3);
  const points = [
    [0, 0],
    [5, 5],
    [10, 10],
  ];
  const knotted = _internals.knotTrajectory(points, [0, 0], [10, 10], 3, 0.2, rng);
  assert.equal(knotted.length, points.length);
});

test("weightedRandomIndex handles zero weights", () => {
  const rng = makeRng(1);
  const index = _internals.weightedRandomIndex([0, 0, 0], rng);
  assert.equal(index, 0);
});
