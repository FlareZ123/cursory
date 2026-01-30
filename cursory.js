"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/**
 * @typedef {Object} Point
 * @property {number} x - The x-coordinate of the point.
 * @property {number} y - The y-coordinate of the point.
 */

/**
 * @typedef {Object} TrajectoryRecord
 * @property {Point[]} points - Points describing the trajectory path.
 * @property {number[]} timing - Timing values in milliseconds per point.
 * @property {number | number[]} dx - Trajectory x delta metadata.
 * @property {number | number[]} dy - Trajectory y delta metadata.
 * @property {number} length - Total trajectory length.
 */

/**
 * @typedef {Object} TrajectorySample
 * @property {Point[]} points - Sampled trajectory points.
 * @property {number[]} timings - Sampled timings in milliseconds.
 */

/**
 * @typedef {Object} TrajectoryOptions
 * @property {number} [frequency=60] - Samples per second.
 * @property {number} [frequencyRandomizer=1] - Max jitter in milliseconds per sample.
 */

/** @type {TrajectoryRecord[] | null} */
let cachedTrajectories = null;
/** @type {{dx: number[], dy: number[], lengths: number[]} | null} */
let cachedFeatures = null;

/**
 * Clamp a number between min and max.
 * @param {number} value - Value to clamp.
 * @param {number} min - Minimum allowable value.
 * @param {number} max - Maximum allowable value.
 * @returns {number} Clamped value.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Assert that a value is a finite number.
 * @param {unknown} value - Value to validate.
 * @param {string} name - Name used for error messages.
 * @returns {number} The validated number.
 */
function assertNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

/**
 * Assert that a value is a valid point object.
 * @param {unknown} value - Value to validate.
 * @param {string} name - Name used for error messages.
 * @returns {Point} The validated point.
 */
function assertPoint(value, name) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${name} must be an object with numeric x and y properties.`);
  }

  /** @type {{x?: unknown, y?: unknown}} */
  const maybePoint = value;
  const x = assertNumber(maybePoint.x, `${name}.x`);
  const y = assertNumber(maybePoint.y, `${name}.y`);
  return { x, y };
}

/**
 * Create a point object.
 * @param {number} x - x coordinate.
 * @param {number} y - y coordinate.
 * @returns {Point} Created point.
 */
function makePoint(x, y) {
  return { x, y };
}

/**
 * Convert a numeric array into a point.
 * @param {number[]} pair - Array containing x and y.
 * @param {string} name - Name used for error context.
 * @returns {Point} Converted point.
 */
function pairToPoint(pair, name) {
  if (!Array.isArray(pair) || pair.length < 2) {
    throw new TypeError(`${name} must be an array with at least two numeric entries.`);
  }
  return { x: assertNumber(pair[0], `${name}[0]`), y: assertNumber(pair[1], `${name}[1]`) };
}

/**
 * Generate a normally distributed random number using Box-Muller transform.
 * @param {number} mean - Mean value.
 * @param {number} stddev - Standard deviation.
 * @returns {number} Gaussian random value.
 */
function gaussianRandom(mean, stddev) {
  assertNumber(mean, "mean");
  assertNumber(stddev, "stddev");
  if (stddev < 0) {
    throw new RangeError("stddev must be non-negative.");
  }
  if (stddev === 0) {
    return mean;
  }

  let u = 0;
  let v = 0;
  while (u === 0) {
    u = Math.random();
  }
  while (v === 0) {
    v = Math.random();
  }
  const magnitude = Math.sqrt(-2.0 * Math.log(u));
  const z0 = magnitude * Math.cos(2.0 * Math.PI * v);
  return mean + z0 * stddev;
}

/**
 * Resolve a delta value into a scalar magnitude.
 * @param {number | number[]} value - Stored delta value.
 * @param {string} label - Error context label.
 * @returns {number} The scalar magnitude.
 */
function resolveDelta(value, label) {
  if (Array.isArray(value)) {
    if (value.length < 2) {
      throw new TypeError(`${label} must have at least two entries when provided as an array.`);
    }
    const dx = assertNumber(value[0], `${label}[0]`);
    const dy = assertNumber(value[1], `${label}[1]`);
    return Math.hypot(dx, dy);
  }
  return assertNumber(value, label);
}

/**
 * Load trajectory data from disk.
 * @returns {{trajectories: TrajectoryRecord[], features: {dx: number[], dy: number[], lengths: number[]}}} Loaded data.
 */
function loadTrajectories() {
  if (cachedTrajectories && cachedFeatures) {
    return { trajectories: cachedTrajectories, features: cachedFeatures };
  }

  const dataPath = path.join(__dirname, "cursory", "trajectories.json.gz");
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Trajectory data file not found at ${dataPath}.`);
  }

  let parsed;
  try {
    const compressed = fs.readFileSync(dataPath);
    const jsonText = zlib.gunzipSync(compressed).toString("utf8");
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load trajectory data: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError("Trajectory data must be an array.");
  }

  /** @type {TrajectoryRecord[]} */
  const trajectories = parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError(`Trajectory entry at index ${index} must be an object.`);
    }

    /** @type {{points?: unknown, timing?: unknown, dx?: unknown, dy?: unknown, length?: unknown}} */
    const record = entry;
    if (!Array.isArray(record.points)) {
      throw new TypeError(`Trajectory points at index ${index} must be an array.`);
    }
    if (!Array.isArray(record.timing)) {
      throw new TypeError(`Trajectory timing at index ${index} must be an array.`);
    }

    const points = record.points.map((pair, pairIndex) => pairToPoint(pair, `trajectory[${index}].points[${pairIndex}]`));
    const timing = record.timing.map((value, timingIndex) =>
      assertNumber(value, `trajectory[${index}].timing[${timingIndex}]`),
    );

    return {
      points,
      timing,
      dx: record.dx,
      dy: record.dy,
      length: assertNumber(record.length, `trajectory[${index}].length`),
    };
  });

  const dx = trajectories.map((trajectory, index) => resolveDelta(trajectory.dx, `trajectory[${index}].dx`));
  const dy = trajectories.map((trajectory, index) => resolveDelta(trajectory.dy, `trajectory[${index}].dy`));
  const lengths = trajectories.map((trajectory) => trajectory.length);

  cachedTrajectories = trajectories;
  cachedFeatures = { dx, dy, lengths };

  return { trajectories, features: cachedFeatures };
}

/**
 * Find the nearest trajectories based on direction and length.
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {number} [directionWeight=0.8] - Weight for direction similarity.
 * @param {number} [lengthWeight=0.2] - Weight for length similarity.
 * @param {number} [topN=5] - Number of top trajectories to return.
 * @returns {TrajectoryRecord[]} Closest trajectories.
 */
function findNearestTrajectory(targetStart, targetEnd, directionWeight = 0.8, lengthWeight = 0.2, topN = 5) {
  assertPoint(targetStart, "targetStart");
  assertPoint(targetEnd, "targetEnd");
  const dirWeight = assertNumber(directionWeight, "directionWeight");
  const lenWeight = assertNumber(lengthWeight, "lengthWeight");
  const count = assertNumber(topN, "topN");
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError("topN must be a positive integer.");
  }

  const { trajectories, features } = loadTrajectories();

  const dxTar = targetEnd.x - targetStart.x;
  const dyTar = targetEnd.y - targetStart.y;
  const lenTar = Math.hypot(dxTar, dyTar);

  if (lenTar === 0) {
    return trajectories
      .map((trajectory, index) => ({ trajectory, length: features.lengths[index] }))
      .sort((a, b) => a.length - b.length)
      .slice(0, count)
      .map((entry) => entry.trajectory);
  }

  const normDxTar = dxTar / lenTar;
  const normDyTar = dyTar / lenTar;

  const scores = trajectories.map((trajectory, index) => {
    const length = features.lengths[index];
    const normDx = length !== 0 ? features.dx[index] / length : 0;
    const normDy = length !== 0 ? features.dy[index] / length : 0;
    const directionSimilarity = normDx * normDxTar + normDy * normDyTar;
    const directionDistance = 1 - directionSimilarity;
    const lengthDiffRatio = Math.abs(length - lenTar) / Math.max(lenTar, 1);
    const combinedScore = dirWeight * directionDistance + lenWeight * lengthDiffRatio;
    return { trajectory, score: combinedScore };
  });

  return scores
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((entry) => entry.trajectory);
}

/**
 * Select the closest trajectory with random sampling bias toward shorter lengths.
 * @param {Point} targetStart - Start point.
 * @param {Point} targetEnd - End point.
 * @param {number} [numNearestToSample=5] - Number of nearest trajectories to sample.
 * @param {number} [randomSampleIterations=20] - Random perturbation iterations.
 * @param {number} [lengthPreferencePower=2] - Power for length bias.
 * @returns {{trajectory: TrajectoryRecord, dxTar: number, dyTar: number, lenTar: number}} Selected trajectory and metadata.
 */
function findClosestTrajectory(
  targetStart,
  targetEnd,
  numNearestToSample = 5,
  randomSampleIterations = 20,
  lengthPreferencePower = 2,
) {
  assertPoint(targetStart, "targetStart");
  assertPoint(targetEnd, "targetEnd");
  const nearestCount = assertNumber(numNearestToSample, "numNearestToSample");
  const sampleIterations = assertNumber(randomSampleIterations, "randomSampleIterations");
  const preferencePower = assertNumber(lengthPreferencePower, "lengthPreferencePower");

  if (!Number.isInteger(nearestCount) || nearestCount <= 0) {
    throw new RangeError("numNearestToSample must be a positive integer.");
  }
  if (!Number.isInteger(sampleIterations) || sampleIterations < 0) {
    throw new RangeError("randomSampleIterations must be a non-negative integer.");
  }
  if (preferencePower <= 0) {
    throw new RangeError("lengthPreferencePower must be greater than 0.");
  }

  const dxTar = targetEnd.x - targetStart.x;
  const dyTar = targetEnd.y - targetStart.y;
  const lenTar = Math.hypot(dxTar, dyTar);

  const topTrajectories = findNearestTrajectory(targetStart, targetEnd, 0.8, 0.2, nearestCount).slice();
  for (let i = 0; i < sampleIterations; i += 1) {
    const perturbation = lenTar * 0.1;
    const perturbedTargetEnd = makePoint(
      targetEnd.x + (Math.random() * 2 - 1) * perturbation,
      targetEnd.y + (Math.random() * 2 - 1) * perturbation,
    );
    topTrajectories.push(...findNearestTrajectory(targetStart, perturbedTargetEnd, 0.8, 0.2, nearestCount));
  }

  const lengths = topTrajectories.map((trajectory) => trajectory.length);
  const epsilon = 1e-10;
  const weights = lengths.map((length) => 1 / Math.pow(length + epsilon, preferencePower));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) {
    throw new Error("Failed to compute trajectory weights.");
  }

  let pick = Math.random() * weightSum;
  let selectedIndex = 0;
  for (let i = 0; i < weights.length; i += 1) {
    pick -= weights[i];
    if (pick <= 0) {
      selectedIndex = i;
      break;
    }
  }

  const trajectory = topTrajectories[selectedIndex];
  if (!trajectory) {
    throw new Error("Unable to select a trajectory.");
  }

  return {
    trajectory,
    dxTar,
    dyTar,
    lenTar,
  };
}

/**
 * Morph a trajectory to match the target start and end points.
 * @param {Point[]} points - Points to morph.
 * @param {Point} targetStart - Target start.
 * @param {Point} targetEnd - Target end.
 * @param {number} dxTar - Target dx.
 * @param {number} dyTar - Target dy.
 * @param {number} lenTar - Target length.
 * @returns {Point[]} Morphed points.
 */
function morphTrajectory(points, targetStart, targetEnd, dxTar, dyTar, lenTar) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("points must be an array with at least two entries.");
  }
  const start = assertPoint(points[0], "points[0]");
  const end = assertPoint(points[points.length - 1], `points[${points.length - 1}]`);

  const dxOrig = end.x - start.x;
  const dyOrig = end.y - start.y;
  const lenOrig = Math.hypot(dxOrig, dyOrig);
  const scaleFactor = lenOrig !== 0 ? lenTar / lenOrig : 1.0;

  const angleOrig = Math.atan2(dyOrig, dxOrig);
  const angleTar = Math.atan2(dyTar, dxTar);
  const rotationAngle = angleTar - angleOrig;
  const cosA = Math.cos(rotationAngle);
  const sinA = Math.sin(rotationAngle);

  return points.map((point, index) => {
    const checkedPoint = assertPoint(point, `points[${index}]`);
    const relX = (checkedPoint.x - start.x) * scaleFactor;
    const relY = (checkedPoint.y - start.y) * scaleFactor;
    const rotatedX = relX * cosA - relY * sinA;
    const rotatedY = relX * sinA + relY * cosA;
    const translatedX = rotatedX + targetStart.x;
    const translatedY = rotatedY + targetStart.y;
    return makePoint(translatedX, translatedY);
  }).map((point, index, allPoints) => {
    if (index === 0) {
      return makePoint(targetStart.x, targetStart.y);
    }
    if (index === allPoints.length - 1) {
      return makePoint(targetEnd.x, targetEnd.y);
    }
    return point;
  });
}

/**
 * Apply jitter to a trajectory.
 * @param {Point[]} points - Original points.
 * @param {number} trajectoryLength - Total trajectory length.
 * @param {number} [scale=0.01] - Base jitter scale.
 * @returns {Point[]} Jittered points.
 */
function jitterTrajectory(points, trajectoryLength, scale = 0.01) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("points must be an array with at least two entries.");
  }
  const lengthScale = Math.min(1.0, trajectoryLength / 400);
  const distances = new Array(points.length - 1).fill(0);
  for (let i = 1; i < points.length; i += 1) {
    const prev = assertPoint(points[i - 1], `points[${i - 1}]`);
    const current = assertPoint(points[i], `points[${i}]`);
    distances[i - 1] = Math.hypot(current.x - prev.x, current.y - prev.y);
  }

  const distancesPrev = new Array(points.length).fill(0);
  const distancesNext = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i += 1) {
    distancesPrev[i] = distances[i - 1];
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    distancesNext[i] = distances[i];
  }

  const adaptiveScales = new Array(points.length).fill(0);
  for (let i = 0; i < points.length; i += 1) {
    const avgDistance = (distancesPrev[i] + distancesNext[i]) / 2;
    const denominator = Math.max(avgDistance, 1);
    adaptiveScales[i] = scale * (avgDistance / denominator) * lengthScale;
  }

  let direction = 1;
  return points.map((point, index) => {
    const current = assertPoint(point, `points[${index}]`);
    const jitterScale = adaptiveScales[index];
    const jitterX = (Math.random() * 0.5 + 0.5) * jitterScale * direction;
    const jitterY = (Math.random() * 0.5 + 0.5) * jitterScale * direction;
    direction *= -1;
    return makePoint(current.x + jitterX, current.y + jitterY);
  });
}

/**
 * Generate a middle-biased random point between two corners.
 * @param {number} x1 - First x coordinate.
 * @param {number} y1 - First y coordinate.
 * @param {number} x2 - Second x coordinate.
 * @param {number} y2 - Second y coordinate.
 * @param {number} [biasFactor=2.0] - Strength of center bias.
 * @returns {Point} Generated point.
 */
function generateMiddleBiasedPoint(x1, y1, x2, y2, biasFactor = 2.0) {
  const minX = Math.min(assertNumber(x1, "x1"), assertNumber(x2, "x2"));
  const maxX = Math.max(assertNumber(x1, "x1"), assertNumber(x2, "x2"));
  const minY = Math.min(assertNumber(y1, "y1"), assertNumber(y2, "y2"));
  const maxY = Math.max(assertNumber(y1, "y1"), assertNumber(y2, "y2"));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const width = maxX - minX;
  const height = maxY - minY;
  const bias = assertNumber(biasFactor, "biasFactor");
  if (bias <= 0) {
    throw new RangeError("biasFactor must be greater than 0.");
  }

  const offsetX = gaussianRandom(0, width / (2 * bias));
  const offsetY = gaussianRandom(0, height / (2 * bias));

  return makePoint(clamp(centerX + offsetX, minX, maxX), clamp(centerY + offsetY, minY, maxY));
}

/**
 * Introduce knots into a trajectory.
 * @param {Point[]} trajectoryPoints - Points to knot.
 * @param {Point} targetStart - Target start.
 * @param {Point} targetEnd - Target end.
 * @param {number} [numKnots=5] - Number of knots.
 * @param {number} [knotStrength=0.15] - Strength of knots.
 * @returns {Point[]} Knotted points.
 */
function knotTrajectory(trajectoryPoints, targetStart, targetEnd, numKnots = 5, knotStrength = 0.15) {
  if (!Array.isArray(trajectoryPoints) || trajectoryPoints.length < 2) {
    throw new Error("trajectoryPoints must be an array with at least two entries.");
  }
  const count = assertNumber(numKnots, "numKnots");
  const strength = assertNumber(knotStrength, "knotStrength");
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("numKnots must be a non-negative integer.");
  }
  if (strength < 0) {
    throw new RangeError("knotStrength must be non-negative.");
  }

  const offsets = trajectoryPoints.map(() => ({ x: 0, y: 0 }));
  for (let i = 0; i < count; i += 1) {
    const knot = generateMiddleBiasedPoint(targetStart.x, targetStart.y, targetEnd.x, targetEnd.y);
    const distances = trajectoryPoints.map((point) => {
      const current = assertPoint(point, "trajectoryPoints[]");
      return Math.hypot(knot.x - current.x, knot.y - current.y);
    });
    const maxDistance = Math.max(...distances);
    if (maxDistance < 1e-6) {
      continue;
    }

    distances.forEach((distance, index) => {
      const point = assertPoint(trajectoryPoints[index], `trajectoryPoints[${index}]`);
      const proximity = 1 - distance / maxDistance;
      const scale = proximity * strength;
      offsets[index].x += (knot.x - point.x) * scale;
      offsets[index].y += (knot.y - point.y) * scale;
    });
  }

  const sqrtSigned = (value) => Math.sign(value) * Math.sqrt(Math.abs(value));
  return trajectoryPoints.map((point, index) => {
    const current = assertPoint(point, `trajectoryPoints[${index}]`);
    const offset = offsets[index];
    return makePoint(current.x + sqrtSigned(offset.x), current.y + sqrtSigned(offset.y));
  });
}

/**
 * Build a trajectory by selecting and morphing a base trajectory.
 * @param {Point} targetStart - Start point.
 * @param {Point} targetEnd - End point.
 * @returns {{points: Point[], timing: number[]}} Trajectory points and base timing.
 */
function findTrajectory(targetStart, targetEnd) {
  const { trajectory, dxTar, dyTar, lenTar } = findClosestTrajectory(targetStart, targetEnd);
  const jitteredPoints = jitterTrajectory(trajectory.points, lenTar);
  const knottedPoints = knotTrajectory(jitteredPoints, targetStart, targetEnd);
  const morphedPoints = morphTrajectory(knottedPoints, targetStart, targetEnd, dxTar, dyTar, lenTar);
  return { points: morphedPoints, timing: trajectory.timing.slice() };
}

/**
 * Generate a realistic mouse trajectory between two points with timings.
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {TrajectoryOptions} [options] - Sampling options.
 * @returns {TrajectorySample} Generated trajectory points and timings.
 */
function generateTrajectory(targetStart, targetEnd, options = {}) {
  const start = assertPoint(targetStart, "targetStart");
  const end = assertPoint(targetEnd, "targetEnd");
  const frequency = options.frequency === undefined ? 60 : assertNumber(options.frequency, "frequency");
  const frequencyRandomizer =
    options.frequencyRandomizer === undefined ? 1 : assertNumber(options.frequencyRandomizer, "frequencyRandomizer");

  if (!Number.isInteger(frequency) || frequency <= 0) {
    throw new RangeError("frequency must be a positive integer.");
  }
  if (!Number.isInteger(frequencyRandomizer) || frequencyRandomizer < 0) {
    throw new RangeError("frequencyRandomizer must be a non-negative integer.");
  }

  const { points: trajectoryPoints, timing } = findTrajectory(start, end);
  if (timing.length === 0) {
    throw new Error("Trajectory timing data is empty.");
  }

  const normalizedTimings = timing.map((value) => value - timing[0]);
  const totalTime = normalizedTimings[normalizedTimings.length - 1];
  const baseStep = Math.floor(1000 / frequency);

  /** @type {Point[]} */
  const sampledPoints = [];
  /** @type {number[]} */
  const sampledTimings = [];

  const findPrevIndex = (timings, sampleTime) => {
    let low = 0;
    let high = timings.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (timings[mid] <= sampleTime) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return Math.max(0, low - 1);
  };

  for (let currentTime = 0; currentTime <= totalTime; currentTime += baseStep) {
    const jitterScale = Math.max(1.5, frequencyRandomizer);
    let jitter = Math.round(gaussianRandom(0, frequencyRandomizer / jitterScale));
    jitter = clamp(jitter, -frequencyRandomizer, frequencyRandomizer);
    const sampleTime = clamp(currentTime + jitter, 0, totalTime);

    const prevIndex = findPrevIndex(normalizedTimings, sampleTime);
    const nextIndex = Math.min(prevIndex + 1, normalizedTimings.length - 1);

    const prevPoint = assertPoint(trajectoryPoints[prevIndex], `trajectoryPoints[${prevIndex}]`);
    const nextPoint = assertPoint(trajectoryPoints[nextIndex], `trajectoryPoints[${nextIndex}]`);
    const prevTime = normalizedTimings[prevIndex];
    const nextTime = normalizedTimings[nextIndex];
    const alpha = nextTime !== prevTime ? (sampleTime - prevTime) / (nextTime - prevTime) : 0;

    const pointX = prevPoint.x + alpha * (nextPoint.x - prevPoint.x);
    const pointY = prevPoint.y + alpha * (nextPoint.y - prevPoint.y);

    sampledPoints.push(makePoint(pointX, pointY));
    sampledTimings.push(sampleTime);
  }

  const trajectoryLength = Math.hypot(end.x - start.x, end.y - start.y);
  const knottedPoints = knotTrajectory(sampledPoints, start, end);
  const jitteredPoints = jitterTrajectory(knottedPoints, trajectoryLength);
  const morphedPoints = morphTrajectory(jitteredPoints, start, end, end.x - start.x, end.y - start.y, trajectoryLength);

  return { points: morphedPoints, timings: sampledTimings };
}

/**
 * Generate a trajectory between two points.
 * @param {Point} from - Start point.
 * @param {Point} to - End point.
 * @param {TrajectoryOptions} [options] - Sampling options.
 * @returns {Point[]} Trajectory points.
 */
function trajectory(from, to, options) {
  const { points } = generateTrajectory(from, to, options);
  return points;
}

module.exports = {
  generateTrajectory,
  trajectory,
};
