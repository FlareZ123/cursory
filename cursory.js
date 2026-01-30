"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/**
 * @typedef {Object} Point
 * @property {number} x - X coordinate in pixels.
 * @property {number} y - Y coordinate in pixels.
 */

/**
 * @typedef {Object} TrajectoryData
 * @property {[number, number]} start - Original start point of the recorded trajectory.
 * @property {[number, number]} end - Original end point of the recorded trajectory.
 * @property {Array<[number, number]>} points - Points that form the recorded trajectory.
 * @property {number|[number, number]} dx - Original x-direction displacement (or 2D vector).
 * @property {number|[number, number]} dy - Original y-direction displacement (or 2D vector).
 * @property {number} length - Total length of the recorded trajectory.
 * @property {number[]} timing - Recorded timing values (ms) for each point.
 */

/**
 * @typedef {Object} TrajectoryOptions
 * @property {number} [frequency=60] - Samples per second.
 * @property {number} [frequencyRandomizer=1] - Max jitter in ms to apply to each sample time.
 * @property {boolean} [returnTimings=false] - When true, return both points and timings.
 * @property {() => number} [rng=Math.random] - Custom RNG for deterministic tests.
 */

/**
 * @typedef {Object} TrajectoryResult
 * @property {Point[]} points - Generated trajectory points.
 * @property {number[]} timings - Timing values in milliseconds for each point.
 */

const TRAJECTORY_PATH = path.join(__dirname, "cursory", "trajectories.json.gz");

/** @type {TrajectoryData[] | null} */
let cachedTrajectories = null;
/** @type {number[] | null} */
let cachedDx = null;
/** @type {number[] | null} */
let cachedDy = null;
/** @type {number[] | null} */
let cachedLengths = null;

/**
 * Assert a value is a finite number.
 * @param {unknown} value - Value to validate.
 * @param {string} name - Label used in error messages.
 */
function assertFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

/**
 * Validate a point-like object and return a normalized tuple.
 * @param {unknown} point - Point to validate.
 * @param {string} name - Name for error messages.
 * @returns {[number, number]}
 */
function normalizePoint(point, name) {
  if (!point || typeof point !== "object") {
    throw new TypeError(`${name} must be an object with x and y numbers.`);
  }
  /** @type {{x?: unknown, y?: unknown}} */
  const candidate = point;
  assertFiniteNumber(candidate.x, `${name}.x`);
  assertFiniteNumber(candidate.y, `${name}.y`);
  return [candidate.x, candidate.y];
}

/**
 * Convert a tuple to a point object.
 * @param {[number, number]} tuple - Tuple to convert.
 * @returns {Point}
 */
function tupleToPoint(tuple) {
  return { x: tuple[0], y: tuple[1] };
}

/**
 * Generate a deterministic Gaussian sample using Box-Muller.
 * @param {() => number} rng - Random number generator.
 * @param {number} [mean=0] - Mean value.
 * @param {number} [stdDev=1] - Standard deviation.
 * @returns {number}
 */
function randomGaussian(rng, mean = 0, stdDev = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = rng();
  }
  while (v === 0) {
    v = rng();
  }
  const mag = Math.sqrt(-2.0 * Math.log(u));
  const z0 = mag * Math.cos(2.0 * Math.PI * v);
  return z0 * stdDev + mean;
}

/**
 * Load trajectory data once and cache computed vectors.
 * @returns {{trajectories: TrajectoryData[], dx: number[], dy: number[], lengths: number[]}}
 */
function loadTrajectories() {
  if (cachedTrajectories && cachedDx && cachedDy && cachedLengths) {
    return {
      trajectories: cachedTrajectories,
      dx: cachedDx,
      dy: cachedDy,
      lengths: cachedLengths,
    };
  }

  if (!fs.existsSync(TRAJECTORY_PATH)) {
    throw new Error(`Trajectory dataset not found at ${TRAJECTORY_PATH}.`);
  }

  let rawData;
  try {
    const compressed = fs.readFileSync(TRAJECTORY_PATH);
    rawData = zlib.gunzipSync(compressed).toString("utf8");
  } catch (error) {
    throw new Error(`Failed to read or decompress trajectory dataset: ${error.message}`);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(rawData);
  } catch (error) {
    throw new Error(`Failed to parse trajectory dataset JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Trajectory dataset is not an array.");
  }

  /** @type {TrajectoryData[]} */
  const trajectories = parsed;
  if (trajectories.length === 0) {
    throw new Error("Trajectory dataset is empty.");
  }

  const dxValues = [];
  const dyValues = [];
  const lengths = [];

  trajectories.forEach((trajectory, index) => {
    if (!trajectory || typeof trajectory !== "object") {
      throw new Error(`Trajectory at index ${index} is invalid.`);
    }
    if (!Array.isArray(trajectory.points) || trajectory.points.length < 2) {
      throw new Error(`Trajectory at index ${index} has invalid points.`);
    }
    assertFiniteNumber(trajectory.length, `trajectory.length at index ${index}`);
    const dx = Array.isArray(trajectory.dx)
      ? Math.hypot(trajectory.dx[0], trajectory.dx[1])
      : trajectory.dx;
    const dy = Array.isArray(trajectory.dy)
      ? Math.hypot(trajectory.dy[0], trajectory.dy[1])
      : trajectory.dy;
    assertFiniteNumber(dx, `trajectory.dx at index ${index}`);
    assertFiniteNumber(dy, `trajectory.dy at index ${index}`);
    dxValues.push(dx);
    dyValues.push(dy);
    lengths.push(trajectory.length);
  });

  cachedTrajectories = trajectories;
  cachedDx = dxValues;
  cachedDy = dyValues;
  cachedLengths = lengths;

  return { trajectories, dx: dxValues, dy: dyValues, lengths };
}

/**
 * Find the top N nearest trajectories to a target segment.
 * @param {[number, number]} targetStart - Target start tuple.
 * @param {[number, number]} targetEnd - Target end tuple.
 * @param {number} [directionWeight=0.8] - Weight for direction similarity.
 * @param {number} [lengthWeight=0.2] - Weight for length similarity.
 * @param {number} [topN=5] - Number of trajectories to return.
 * @returns {TrajectoryData[]}
 */
function findNearestTrajectory(targetStart, targetEnd, directionWeight = 0.8, lengthWeight = 0.2, topN = 5) {
  const { trajectories, dx, dy, lengths } = loadTrajectories();
  assertFiniteNumber(directionWeight, "directionWeight");
  assertFiniteNumber(lengthWeight, "lengthWeight");
  if (!Number.isInteger(topN) || topN <= 0) {
    throw new TypeError("topN must be a positive integer.");
  }

  const dxTarget = targetEnd[0] - targetStart[0];
  const dyTarget = targetEnd[1] - targetStart[1];
  const lengthTarget = Math.hypot(dxTarget, dyTarget);

  if (lengthTarget === 0) {
    const indices = lengths
      .map((value, index) => ({ index, value }))
      .sort((a, b) => a.value - b.value)
      .slice(0, topN)
      .map((entry) => entry.index);
    return indices.map((index) => trajectories[index]);
  }

  const normDxTarget = dxTarget / lengthTarget;
  const normDyTarget = dyTarget / lengthTarget;

  const scored = lengths.map((length, index) => {
    const normDx = length !== 0 ? dx[index] / length : 0;
    const normDy = length !== 0 ? dy[index] / length : 0;
    const directionSimilarity = normDx * normDxTarget + normDy * normDyTarget;
    const directionDistance = 1 - directionSimilarity;
    const lengthDiffRatio = Math.abs(length - lengthTarget) / Math.max(lengthTarget, 1);
    const score = directionWeight * directionDistance + lengthWeight * lengthDiffRatio;
    return { index, score };
  });

  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, topN)
    .map((entry) => trajectories[entry.index]);
}

/**
 * Weighted random selection.
 * @param {number[]} weights - Weight values.
 * @param {() => number} rng - Random number generator.
 * @returns {number}
 */
function weightedRandomIndex(weights, rng) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  let threshold = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    threshold -= weights[i];
    if (threshold <= 0) {
      return i;
    }
  }
  return weights.length - 1;
}

/**
 * Find the closest trajectory with a bias for shorter lengths.
 * @param {[number, number]} targetStart - Target start tuple.
 * @param {[number, number]} targetEnd - Target end tuple.
 * @param {number} [numNearestToSample=5] - Number of nearest trajectories to consider.
 * @param {number} [randomSampleIterations=20] - Number of perturbations to sample.
 * @param {number} [lengthPreferencePower=2] - Bias power for shorter trajectories.
 * @param {() => number} [rng=Math.random] - Random number generator.
 * @returns {{trajectory: TrajectoryData, dxTarget: number, dyTarget: number, lengthTarget: number}}
 */
function findClosestTrajectory(
  targetStart,
  targetEnd,
  numNearestToSample = 5,
  randomSampleIterations = 20,
  lengthPreferencePower = 2,
  rng = Math.random,
) {
  if (!Number.isInteger(numNearestToSample) || numNearestToSample <= 0) {
    throw new TypeError("numNearestToSample must be a positive integer.");
  }
  if (!Number.isInteger(randomSampleIterations) || randomSampleIterations < 0) {
    throw new TypeError("randomSampleIterations must be a non-negative integer.");
  }
  assertFiniteNumber(lengthPreferencePower, "lengthPreferencePower");

  const dxTarget = targetEnd[0] - targetStart[0];
  const dyTarget = targetEnd[1] - targetStart[1];
  const lengthTarget = Math.hypot(dxTarget, dyTarget);

  const topTrajectories = findNearestTrajectory(targetStart, targetEnd, 0.8, 0.2, numNearestToSample);

  const perturbScale = lengthTarget * 0.1;
  for (let i = 0; i < randomSampleIterations; i += 1) {
    const perturbedTargetEnd = [
      targetEnd[0] + (rng() * 2 - 1) * perturbScale,
      targetEnd[1] + (rng() * 2 - 1) * perturbScale,
    ];
    topTrajectories.push(
      ...findNearestTrajectory(targetStart, perturbedTargetEnd, 0.8, 0.2, numNearestToSample),
    );
  }

  const lengths = topTrajectories.map((trajectory) => trajectory.length);
  const epsilon = 1e-10;
  const inverseLengths = lengths.map((length) => 1 / Math.pow(length + epsilon, lengthPreferencePower));
  const selectedIndex = weightedRandomIndex(inverseLengths, rng);

  return {
    trajectory: topTrajectories[selectedIndex],
    dxTarget,
    dyTarget,
    lengthTarget,
  };
}

/**
 * Morph a trajectory to match a new target segment.
 * @param {Array<[number, number]>} points - Points to morph.
 * @param {[number, number]} targetStart - Target start tuple.
 * @param {[number, number]} targetEnd - Target end tuple.
 * @param {number} dxTarget - Target x displacement.
 * @param {number} dyTarget - Target y displacement.
 * @param {number} lengthTarget - Target length.
 * @returns {Array<[number, number]>}
 */
function morphTrajectory(points, targetStart, targetEnd, dxTarget, dyTarget, lengthTarget) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new TypeError("points must be an array with at least two points.");
  }
  const start = points[0];
  const end = points[points.length - 1];
  const dxOrig = end[0] - start[0];
  const dyOrig = end[1] - start[1];
  const lengthOrig = Math.hypot(dxOrig, dyOrig);
  const scaleFactor = lengthOrig !== 0 ? lengthTarget / lengthOrig : 1;

  const angleOrig = Math.atan2(dyOrig, dxOrig);
  const angleTarget = Math.atan2(dyTarget, dxTarget);
  const rotationAngle = angleTarget - angleOrig;
  const cosA = Math.cos(rotationAngle);
  const sinA = Math.sin(rotationAngle);

  const morphed = points.map((point) => {
    const relativeX = (point[0] - start[0]) * scaleFactor;
    const relativeY = (point[1] - start[1]) * scaleFactor;
    const rotatedX = relativeX * cosA - relativeY * sinA;
    const rotatedY = relativeX * sinA + relativeY * cosA;
    return [rotatedX + targetStart[0], rotatedY + targetStart[1]];
  });

  morphed[0] = [targetStart[0], targetStart[1]];
  morphed[morphed.length - 1] = [targetEnd[0], targetEnd[1]];
  return morphed;
}

/**
 * Apply smooth jitter to trajectory points.
 * @param {Array<[number, number]>} points - Points to jitter.
 * @param {number} trajectoryLength - Length of the trajectory.
 * @param {number} [scale=0.01] - Base jitter scale.
 * @param {() => number} [rng=Math.random] - Random number generator.
 * @returns {Array<[number, number]>}
 */
function jitterTrajectory(points, trajectoryLength, scale = 0.01, rng = Math.random) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new TypeError("points must be an array with at least two points.");
  }
  assertFiniteNumber(trajectoryLength, "trajectoryLength");
  assertFiniteNumber(scale, "scale");

  const lengthScale = Math.min(1.0, trajectoryLength / 400);
  const distancesPrev = new Array(points.length).fill(0);
  const distancesNext = new Array(points.length).fill(0);
  const distances = [];

  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    distances.push(Math.hypot(dx, dy));
  }

  for (let i = 1; i < points.length; i += 1) {
    distancesPrev[i] = distances[i - 1] ?? 0;
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    distancesNext[i] = distances[i] ?? 0;
  }

  const jittered = points.map((point, index) => {
    const avgDistance = (distancesPrev[index] + distancesNext[index]) / 2;
    const adaptiveScale = scale * (avgDistance / Math.max(avgDistance, 1)) * lengthScale;
    const jitterX = (rng() * 0.5 + 0.5) * adaptiveScale * (index % 2 === 0 ? 1 : -1);
    const jitterY = (rng() * 0.5 + 0.5) * adaptiveScale * (index % 2 === 0 ? 1 : -1);
    return [point[0] + jitterX, point[1] + jitterY];
  });

  return jittered;
}

/**
 * Generate a point biased toward the middle of a rectangle.
 * @param {number} x1 - First corner x.
 * @param {number} y1 - First corner y.
 * @param {number} x2 - Second corner x.
 * @param {number} y2 - Second corner y.
 * @param {number} [biasFactor=2] - Bias strength.
 * @param {() => number} [rng=Math.random] - Random number generator.
 * @returns {[number, number]}
 */
function generateMiddleBiasedPoint(x1, y1, x2, y2, biasFactor = 2, rng = Math.random) {
  assertFiniteNumber(x1, "x1");
  assertFiniteNumber(y1, "y1");
  assertFiniteNumber(x2, "x2");
  assertFiniteNumber(y2, "y2");
  assertFiniteNumber(biasFactor, "biasFactor");

  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const width = maxX - minX;
  const height = maxY - minY;

  const offsetX = randomGaussian(rng, 0, width / (2 * biasFactor));
  const offsetY = randomGaussian(rng, 0, height / (2 * biasFactor));

  const x = Math.max(minX, Math.min(maxX, centerX + offsetX));
  const y = Math.max(minY, Math.min(maxY, centerY + offsetY));

  return [x, y];
}

/**
 * Introduce knots to a trajectory to vary its shape.
 * @param {Array<[number, number]>} trajPoints - Points to knot.
 * @param {[number, number]} targetStart - Target start tuple.
 * @param {[number, number]} targetEnd - Target end tuple.
 * @param {number} [numKnots=5] - Number of knots.
 * @param {number} [knotStrength=0.15] - Knot strength.
 * @param {() => number} [rng=Math.random] - Random number generator.
 * @returns {Array<[number, number]>}
 */
function knotTrajectory(
  trajPoints,
  targetStart,
  targetEnd,
  numKnots = 5,
  knotStrength = 0.15,
  rng = Math.random,
) {
  if (!Array.isArray(trajPoints) || trajPoints.length < 2) {
    throw new TypeError("trajPoints must be an array with at least two points.");
  }
  if (!Number.isInteger(numKnots) || numKnots <= 0) {
    throw new TypeError("numKnots must be a positive integer.");
  }
  assertFiniteNumber(knotStrength, "knotStrength");

  const knotPoints = trajPoints.map(() => [0, 0]);

  for (let i = 0; i < numKnots; i += 1) {
    const knot = generateMiddleBiasedPoint(
      targetStart[0],
      targetStart[1],
      targetEnd[0],
      targetEnd[1],
      2,
      rng,
    );
    let maxDistance = 0;
    const diffVectors = trajPoints.map((point) => {
      const dx = knot[0] - point[0];
      const dy = knot[1] - point[1];
      const distance = Math.hypot(dx, dy);
      maxDistance = Math.max(maxDistance, distance);
      return { dx, dy, distance };
    });

    if (maxDistance < 1e-6) {
      continue;
    }

    diffVectors.forEach((vector, index) => {
      const proximity = 1 - vector.distance / maxDistance;
      const scaling = proximity * knotStrength;
      knotPoints[index][0] += vector.dx * scaling;
      knotPoints[index][1] += vector.dy * scaling;
    });
  }

  const knotted = trajPoints.map((point, index) => {
    const offsetX = Math.sign(knotPoints[index][0]) * Math.sqrt(Math.abs(knotPoints[index][0]));
    const offsetY = Math.sign(knotPoints[index][1]) * Math.sqrt(Math.abs(knotPoints[index][1]));
    return [point[0] + offsetX, point[1] + offsetY];
  });

  return knotted;
}

/**
 * Select and transform a base trajectory for a target segment.
 * @param {[number, number]} targetStart - Target start tuple.
 * @param {[number, number]} targetEnd - Target end tuple.
 * @param {() => number} [rng=Math.random] - Random number generator.
 * @returns {{points: Array<[number, number]>, timings: number[]}}
 */
function findTrajectory(targetStart, targetEnd, rng = Math.random) {
  const { trajectory, dxTarget, dyTarget, lengthTarget } = findClosestTrajectory(
    targetStart,
    targetEnd,
    5,
    20,
    2,
    rng,
  );

  const jittered = jitterTrajectory(trajectory.points, lengthTarget, 0.01, rng);
  const knotted = knotTrajectory(jittered, targetStart, targetEnd, 5, 0.15, rng);
  const morphed = morphTrajectory(knotted, targetStart, targetEnd, dxTarget, dyTarget, lengthTarget);

  return {
    points: morphed,
    timings: trajectory.timing,
  };
}

/**
 * Generate a realistic trajectory sampled at a desired frequency.
 * @param {[number, number]} targetStart - Target start tuple.
 * @param {[number, number]} targetEnd - Target end tuple.
 * @param {number} frequency - Samples per second.
 * @param {number} frequencyRandomizer - Jitter in ms to apply to each sample.
 * @param {() => number} rng - Random number generator.
 * @returns {{points: Array<[number, number]>, timings: number[]}}
 */
function generateTrajectory(targetStart, targetEnd, frequency, frequencyRandomizer, rng) {
  assertFiniteNumber(frequency, "frequency");
  assertFiniteNumber(frequencyRandomizer, "frequencyRandomizer");
  if (frequency <= 0) {
    throw new RangeError("frequency must be greater than zero.");
  }
  if (frequencyRandomizer < 0) {
    throw new RangeError("frequencyRandomizer must be non-negative.");
  }

  const { points: trajectoryPoints, timings } = findTrajectory(targetStart, targetEnd, rng);
  const normalizedTimings = timings.map((time) => time - timings[0]);
  const totalTime = normalizedTimings[normalizedTimings.length - 1];
  const baseStep = Math.floor(1000 / frequency);
  if (baseStep <= 0) {
    throw new RangeError("frequency is too high to generate samples.");
  }

  /** @type {Array<[number, number]>} */
  const sampledPoints = [];
  /** @type {number[]} */
  const sampledTimings = [];

  let currentTime = 0;
  while (currentTime <= totalTime) {
    const jitterScale = Math.max(1.5, frequencyRandomizer || 1);
    const jitter = Math.max(
      -frequencyRandomizer,
      Math.min(frequencyRandomizer, Math.round(randomGaussian(rng, 0, frequencyRandomizer / jitterScale))),
    );
    const sampleTime = Math.max(0, Math.min(totalTime, currentTime + jitter));

    let prevIndex = 0;
    for (let i = 0; i < normalizedTimings.length; i += 1) {
      if (normalizedTimings[i] <= sampleTime) {
        prevIndex = i;
      } else {
        break;
      }
    }
    const nextIndex = Math.min(prevIndex + 1, normalizedTimings.length - 1);

    const prevPoint = trajectoryPoints[prevIndex];
    const nextPoint = trajectoryPoints[nextIndex];
    const prevTime = normalizedTimings[prevIndex];
    const nextTime = normalizedTimings[nextIndex];

    const alpha = nextTime !== prevTime ? (sampleTime - prevTime) / (nextTime - prevTime) : 0;
    const pointX = prevPoint[0] + alpha * (nextPoint[0] - prevPoint[0]);
    const pointY = prevPoint[1] + alpha * (nextPoint[1] - prevPoint[1]);

    sampledPoints.push([pointX, pointY]);
    sampledTimings.push(sampleTime);

    currentTime += baseStep;
  }

  const trajectoryLength = Math.hypot(targetEnd[0] - targetStart[0], targetEnd[1] - targetStart[1]);
  const knotted = knotTrajectory(sampledPoints, targetStart, targetEnd, 5, 0.15, rng);
  const jittered = jitterTrajectory(knotted, trajectoryLength, 0.01, rng);
  const dxTarget = targetEnd[0] - targetStart[0];
  const dyTarget = targetEnd[1] - targetStart[1];
  const lengthTarget = Math.hypot(dxTarget, dyTarget);
  const morphed = morphTrajectory(jittered, targetStart, targetEnd, dxTarget, dyTarget, lengthTarget);

  return { points: morphed, timings: sampledTimings };
}

/**
 * Generate a realistic trajectory between two points.
 * @param {Point} from - Starting point.
 * @param {Point} to - Ending point.
 * @param {TrajectoryOptions} [options] - Generation options.
 * @returns {Point[] | TrajectoryResult}
 */
function trajectory(from, to, options = {}) {
  const targetStart = normalizePoint(from, "from");
  const targetEnd = normalizePoint(to, "to");
  const frequency = options.frequency ?? 60;
  const frequencyRandomizer = options.frequencyRandomizer ?? 1;
  const rng = options.rng ?? Math.random;

  const { points, timings } = generateTrajectory(
    targetStart,
    targetEnd,
    frequency,
    frequencyRandomizer,
    rng,
  );

  const convertedPoints = points.map(tupleToPoint);
  if (options.returnTimings) {
    return { points: convertedPoints, timings };
  }
  return convertedPoints;
}

module.exports = {
  trajectory,
  _internals: {
    loadTrajectories,
    findNearestTrajectory,
    findClosestTrajectory,
    morphTrajectory,
    jitterTrajectory,
    generateMiddleBiasedPoint,
    knotTrajectory,
    findTrajectory,
    generateTrajectory,
    weightedRandomIndex,
    randomGaussian,
    normalizePoint,
    tupleToPoint,
  },
};
