"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/**
 * @typedef {Object} Point
 * @property {number} x - X coordinate.
 * @property {number} y - Y coordinate.
 */

/**
 * @typedef {Object} Trajectory
 * @property {Array<[number, number]>} points - Trajectory points in [x, y] tuples.
 * @property {number|[number, number]} dx - X displacement or [dx, dy] vector.
 * @property {number|[number, number]} dy - Y displacement or [dx, dy] vector.
 * @property {number} length - Total trajectory length.
 * @property {Array<number>} timing - Timing data for trajectory points in ms.
 */

/**
 * @typedef {Object} TrajectoryOptions
 * @property {number} [frequency=60] - Sample rate in hz used to resample trajectory timing.
 * @property {number} [frequencyRandomizer=1] - Max jitter in ms applied to each sample time.
 * @property {() => number} [random=Math.random] - RNG returning a float in [0, 1).
 */

/**
 * @typedef {Object} InternalState
 * @property {Array<Trajectory>} trajectories - Loaded trajectory data.
 * @property {Array<number>} trajectoryDx - Precomputed dx magnitudes.
 * @property {Array<number>} trajectoryDy - Precomputed dy magnitudes.
 * @property {Array<number>} trajectoryLengths - Precomputed trajectory lengths.
 */

const TRAJECTORY_PATH = path.join(__dirname, "cursory", "trajectories.json.gz");

/** @type {InternalState | null} */
let cachedState = null;

/**
 * Loads trajectory data from disk and computes cached metrics.
 * @returns {InternalState}
 */
function loadTrajectories() {
  if (cachedState) {
    return cachedState;
  }

  if (!fs.existsSync(TRAJECTORY_PATH)) {
    throw new Error(`Trajectory data not found at ${TRAJECTORY_PATH}.`);
  }

  const gzData = fs.readFileSync(TRAJECTORY_PATH);
  let parsed;
  try {
    const jsonText = zlib.gunzipSync(gzData).toString("utf8");
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load trajectory data: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Trajectory data must be a JSON array.");
  }

  /** @type {Array<Trajectory>} */
  const trajectories = parsed;

  const trajectoryDx = trajectories.map((traj) => {
    if (Array.isArray(traj.dx)) {
      return Math.hypot(traj.dx[0], traj.dx[1]);
    }
    return traj.dx;
  });

  const trajectoryDy = trajectories.map((traj) => {
    if (Array.isArray(traj.dy)) {
      return Math.hypot(traj.dy[0], traj.dy[1]);
    }
    return traj.dy;
  });

  const trajectoryLengths = trajectories.map((traj) => traj.length);

  cachedState = {
    trajectories,
    trajectoryDx,
    trajectoryDy,
    trajectoryLengths,
  };

  return cachedState;
}

/**
 * Validates a point-like object.
 * @param {Point} point - Point to validate.
 * @param {string} label - Label for error messages.
 */
function assertPoint(point, label) {
  if (!point || typeof point !== "object") {
    throw new TypeError(`${label} must be an object with numeric x and y.`);
  }

  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError(`${label}.x and ${label}.y must be finite numbers.`);
  }
}

/**
 * Ensures a numeric option is valid.
 * @param {number} value - Value to validate.
 * @param {string} label - Option name.
 */
function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

/**
 * @param {() => number} rng - RNG returning values in [0, 1).
 * @param {number} min - Minimum value.
 * @param {number} max - Maximum value.
 * @returns {number}
 */
function randomUniform(rng, min, max) {
  return min + (max - min) * rng();
}

/**
 * Generates a Gaussian distributed value using the Box-Muller transform.
 * @param {() => number} rng - RNG returning values in [0, 1).
 * @param {number} mean - Mean of the distribution.
 * @param {number} stdDev - Standard deviation.
 * @returns {number}
 */
function randomGaussian(rng, mean, stdDev) {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = rng();
  }
  while (v === 0) {
    v = rng();
  }
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * stdDev;
}

/**
 * Selects an index based on weights.
 * @param {() => number} rng - RNG returning values in [0, 1).
 * @param {Array<number>} weights - Normalized weights that sum to 1.
 * @returns {number}
 */
function weightedChoice(rng, weights) {
  const target = rng();
  let cumulative = 0;
  for (let i = 0; i < weights.length; i += 1) {
    cumulative += weights[i];
    if (target <= cumulative) {
      return i;
    }
  }
  return Math.max(0, weights.length - 1);
}

/**
 * Finds the nearest trajectories based on direction and length similarity.
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {Object} [options] - Options for ranking.
 * @param {number} [options.directionWeight=0.8] - Weight for direction similarity.
 * @param {number} [options.lengthWeight=0.2] - Weight for length similarity.
 * @param {number} [options.topN=5] - Number of trajectories to return.
 * @returns {Array<Trajectory>}
 */
function findNearestTrajectory(targetStart, targetEnd, options = {}) {
  const { directionWeight = 0.8, lengthWeight = 0.2, topN = 5 } = options;
  const { trajectories, trajectoryDx, trajectoryDy, trajectoryLengths } = loadTrajectories();

  assertFiniteNumber(directionWeight, "directionWeight");
  assertFiniteNumber(lengthWeight, "lengthWeight");
  assertFiniteNumber(topN, "topN");

  const dxTar = targetEnd.x - targetStart.x;
  const dyTar = targetEnd.y - targetStart.y;
  const lenTar = Math.hypot(dxTar, dyTar);

  if (lenTar === 0) {
    const sorted = trajectoryLengths
      .map((length, index) => ({ length, index }))
      .sort((a, b) => a.length - b.length)
      .slice(0, topN)
      .map((item) => trajectories[item.index]);
    return sorted;
  }

  const normDxTar = dxTar / lenTar;
  const normDyTar = dyTar / lenTar;

  /** @type {Array<{score: number, index: number}>} */
  const scored = [];
  for (let i = 0; i < trajectories.length; i += 1) {
    const length = trajectoryLengths[i];
    const normDx = length !== 0 ? trajectoryDx[i] / length : 0;
    const normDy = length !== 0 ? trajectoryDy[i] / length : 0;

    const directionSimilarity = normDx * normDxTar + normDy * normDyTar;
    const directionDistance = 1 - directionSimilarity;

    const lengthDiffRatio = Math.abs(length - lenTar) / Math.max(lenTar, 1);
    const combinedScore = directionWeight * directionDistance + lengthWeight * lengthDiffRatio;

    scored.push({ score: combinedScore, index: i });
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, topN).map((item) => trajectories[item.index]);
}

/**
 * Finds the closest trajectory with bias towards shorter lengths.
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {Object} [options] - Selection options.
 * @param {number} [options.numNearestToSample=5] - Number of nearest candidates.
 * @param {number} [options.randomSampleIterations=20] - Number of perturbations.
 * @param {number} [options.lengthPreferencePower=2] - Power for inverse length weighting.
 * @param {() => number} [options.random=Math.random] - RNG returning values in [0, 1).
 * @returns {{trajectory: Trajectory, dxTar: number, dyTar: number, lenTar: number}}
 */
function findClosestTrajectory(targetStart, targetEnd, options = {}) {
  const {
    numNearestToSample = 5,
    randomSampleIterations = 20,
    lengthPreferencePower = 2,
    random = Math.random,
  } = options;

  assertFiniteNumber(numNearestToSample, "numNearestToSample");
  assertFiniteNumber(randomSampleIterations, "randomSampleIterations");
  assertFiniteNumber(lengthPreferencePower, "lengthPreferencePower");

  const dxTar = targetEnd.x - targetStart.x;
  const dyTar = targetEnd.y - targetStart.y;
  const lenTar = Math.hypot(dxTar, dyTar);

  let topTrajectories = findNearestTrajectory(targetStart, targetEnd, {
    topN: numNearestToSample,
  });

  for (let i = 0; i < randomSampleIterations; i += 1) {
    const perturb = lenTar * 0.1;
    const perturbedTargetEnd = {
      x: targetEnd.x + randomUniform(random, -perturb, perturb),
      y: targetEnd.y + randomUniform(random, -perturb, perturb),
    };
    topTrajectories = topTrajectories.concat(
      findNearestTrajectory(targetStart, perturbedTargetEnd, {
        topN: numNearestToSample,
      }),
    );
  }

  const lengths = topTrajectories.map((traj) => traj.length);
  const epsilon = 1e-10;
  const inverseLengths = lengths.map(
    (length) => 1.0 / Math.pow(length + epsilon, lengthPreferencePower),
  );
  const totalWeight = inverseLengths.reduce((sum, value) => sum + value, 0);

  if (totalWeight === 0) {
    return { trajectory: topTrajectories[0], dxTar, dyTar, lenTar };
  }

  const weights = inverseLengths.map((value) => value / totalWeight);
  const selectedIndex = weightedChoice(random, weights);

  return {
    trajectory: topTrajectories[selectedIndex],
    dxTar,
    dyTar,
    lenTar,
  };
}

/**
 * Morphs a trajectory to match target start and end points.
 * @param {Array<[number, number]>} points - Original trajectory points.
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {number} dxTar - Target displacement in x.
 * @param {number} dyTar - Target displacement in y.
 * @param {number} lenTar - Target length.
 * @returns {Array<[number, number]>}
 */
function morphTrajectory(points, targetStart, targetEnd, dxTar, dyTar, lenTar) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("Trajectory points must be a non-empty array.");
  }

  const start = points[0];
  const end = points[points.length - 1];

  const dxOrig = end[0] - start[0];
  const dyOrig = end[1] - start[1];
  const lenOrig = Math.hypot(dxOrig, dyOrig);

  const scaleFactor = lenOrig !== 0 ? lenTar / lenOrig : 1.0;
  const angleOrig = Math.atan2(dyOrig, dxOrig);
  const angleTar = Math.atan2(dyTar, dxTar);
  const rotationAngle = angleTar - angleOrig;
  const cosA = Math.cos(rotationAngle);
  const sinA = Math.sin(rotationAngle);

  const morphed = points.map(([x, y]) => {
    const relX = (x - start[0]) * scaleFactor;
    const relY = (y - start[1]) * scaleFactor;
    const rotX = relX * cosA - relY * sinA;
    const rotY = relX * sinA + relY * cosA;
    return [rotX + targetStart.x, rotY + targetStart.y];
  });

  morphed[0] = [targetStart.x, targetStart.y];
  morphed[morphed.length - 1] = [targetEnd.x, targetEnd.y];
  return morphed;
}

/**
 * Applies smooth jitter to trajectory points.
 * @param {Array<[number, number]>} points - Trajectory points.
 * @param {number} trajectoryLength - Trajectory length.
 * @param {Object} [options] - Jitter options.
 * @param {number} [options.scale=0.01] - Base jitter scale.
 * @param {() => number} [options.random=Math.random] - RNG returning values in [0, 1).
 * @returns {Array<[number, number]>}
 */
function jitterTrajectory(points, trajectoryLength, options = {}) {
  const { scale = 0.01, random = Math.random } = options;

  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("Trajectory points must be a non-empty array.");
  }
  assertFiniteNumber(trajectoryLength, "trajectoryLength");
  assertFiniteNumber(scale, "scale");

  const lengthScale = Math.min(1.0, trajectoryLength / 400);
  const distancesPrev = new Array(points.length).fill(0);
  const distancesNext = new Array(points.length).fill(0);

  for (let i = 0; i < points.length - 1; i += 1) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const distance = Math.hypot(dx, dy);
    distancesPrev[i + 1] = distance;
    distancesNext[i] = distance;
  }

  const jittered = points.map((point, index) => {
    const avgDistance = (distancesPrev[index] + distancesNext[index]) / 2;
    const adaptiveScale = scale * (avgDistance / Math.max(avgDistance, 1)) * lengthScale;
    const jitterX = randomUniform(random, 0.5, 1) * adaptiveScale * (index % 2 === 0 ? 1 : -1);
    const jitterY = randomUniform(random, 0.5, 1) * adaptiveScale * (index % 2 === 0 ? 1 : -1);
    return [point[0] + jitterX, point[1] + jitterY];
  });

  return jittered;
}

/**
 * Generates a Gaussian-biased point inside the bounding rectangle.
 * @param {number} x1 - First x coordinate.
 * @param {number} y1 - First y coordinate.
 * @param {number} x2 - Second x coordinate.
 * @param {number} y2 - Second y coordinate.
 * @param {Object} [options] - Generation options.
 * @param {number} [options.biasFactor=2.0] - Bias factor for center weighting.
 * @param {() => number} [options.random=Math.random] - RNG returning values in [0, 1).
 * @returns {[number, number]}
 */
function generateMiddleBiasedPoint(x1, y1, x2, y2, options = {}) {
  const { biasFactor = 2.0, random = Math.random } = options;

  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const width = maxX - minX;
  const height = maxY - minY;

  const offsetX = randomGaussian(random, 0, width / (2 * biasFactor));
  const offsetY = randomGaussian(random, 0, height / (2 * biasFactor));

  const x = Math.max(minX, Math.min(maxX, centerX + offsetX));
  const y = Math.max(minY, Math.min(maxY, centerY + offsetY));

  return [x, y];
}

/**
 * Applies knotting to a trajectory to introduce additional variation.
 * @param {Array<[number, number]>} trajPoints - Trajectory points.
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {Object} [options] - Knot options.
 * @param {number} [options.numKnots=5] - Number of knots.
 * @param {number} [options.knotStrength=0.15] - Strength of knot displacement.
 * @param {() => number} [options.random=Math.random] - RNG returning values in [0, 1).
 * @returns {Array<[number, number]>}
 */
function knotTrajectory(trajPoints, targetStart, targetEnd, options = {}) {
  const { numKnots = 5, knotStrength = 0.15, random = Math.random } = options;

  if (!Array.isArray(trajPoints) || trajPoints.length === 0) {
    throw new Error("Trajectory points must be a non-empty array.");
  }

  const knotOffsets = trajPoints.map(() => [0, 0]);

  for (let i = 0; i < numKnots; i += 1) {
    const knot = generateMiddleBiasedPoint(
      targetStart.x,
      targetStart.y,
      targetEnd.x,
      targetEnd.y,
      { random },
    );

    const distances = trajPoints.map((point) => Math.hypot(knot[0] - point[0], knot[1] - point[1]));
    const maxDistance = Math.max(...distances);

    if (maxDistance < 1e-6) {
      continue;
    }

    for (let index = 0; index < trajPoints.length; index += 1) {
      const proximity = 1.0 - distances[index] / maxDistance;
      const scalingFactor = proximity * knotStrength;
      knotOffsets[index][0] += (knot[0] - trajPoints[index][0]) * scalingFactor;
      knotOffsets[index][1] += (knot[1] - trajPoints[index][1]) * scalingFactor;
    }
  }

  return trajPoints.map((point, index) => {
    const offsetX = knotOffsets[index][0];
    const offsetY = knotOffsets[index][1];
    const sqrtOffsetX = Math.sign(offsetX) * Math.sqrt(Math.abs(offsetX));
    const sqrtOffsetY = Math.sign(offsetY) * Math.sqrt(Math.abs(offsetY));
    return [point[0] + sqrtOffsetX, point[1] + sqrtOffsetY];
  });
}

/**
 * Generates a trajectory by selecting and morphing an existing sample.
 * @param {Point} targetStart - Start point.
 * @param {Point} targetEnd - End point.
 * @param {Object} [options] - Generation options.
 * @param {() => number} [options.random=Math.random] - RNG returning values in [0, 1).
 * @returns {{points: Array<[number, number]>, timings: Array<number>}}
 */
function findTrajectory(targetStart, targetEnd, options = {}) {
  const { random = Math.random } = options;

  const { trajectory, dxTar, dyTar, lenTar } = findClosestTrajectory(targetStart, targetEnd, {
    random,
  });

  const jitteredPoints = jitterTrajectory(trajectory.points, lenTar, { random });
  const knottedPoints = knotTrajectory(jitteredPoints, targetStart, targetEnd, { random });
  const morphedPoints = morphTrajectory(knottedPoints, targetStart, targetEnd, dxTar, dyTar, lenTar);

  return { points: morphedPoints, timings: trajectory.timing };
}

/**
 * Generates a realistic mouse trajectory and timings.
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {TrajectoryOptions} [options] - Trajectory options.
 * @returns {{points: Array<Point>, timings: Array<number>}}
 */
function trajectoryWithTimings(targetStart, targetEnd, options = {}) {
  assertPoint(targetStart, "targetStart");
  assertPoint(targetEnd, "targetEnd");

  const {
    frequency = 60,
    frequencyRandomizer = 1,
    random = Math.random,
  } = options;

  assertFiniteNumber(frequency, "frequency");
  assertFiniteNumber(frequencyRandomizer, "frequencyRandomizer");

  const { points, timings } = findTrajectory(targetStart, targetEnd, { random });

  const normalizedTimings = timings.map((time) => time - timings[0]);
  const totalTime = normalizedTimings[normalizedTimings.length - 1];
  const baseStep = Math.floor(1000 / frequency);

  /** @type {Array<[number, number]>} */
  const sampledPoints = [];
  /** @type {Array<number>} */
  const sampledTimings = [];

  let currentTime = 0;
  while (currentTime <= totalTime) {
    const jitterScale = Math.max(1.5, frequencyRandomizer);
    let jitter = Math.round(randomGaussian(random, 0, frequencyRandomizer / jitterScale));
    jitter = Math.max(-frequencyRandomizer, Math.min(frequencyRandomizer, jitter));

    const sampleTime = Math.max(0, Math.min(totalTime, currentTime + jitter));

    let prevIdx = 0;
    for (let i = 0; i < normalizedTimings.length; i += 1) {
      if (normalizedTimings[i] <= sampleTime) {
        prevIdx = i;
      } else {
        break;
      }
    }

    const nextIdx = Math.min(prevIdx + 1, normalizedTimings.length - 1);

    const prevPoint = points[prevIdx];
    const nextPoint = points[nextIdx];
    const prevTime = normalizedTimings[prevIdx];
    const nextTime = normalizedTimings[nextIdx];

    const alpha = nextTime !== prevTime ? (sampleTime - prevTime) / (nextTime - prevTime) : 0.0;
    const pointX = prevPoint[0] + alpha * (nextPoint[0] - prevPoint[0]);
    const pointY = prevPoint[1] + alpha * (nextPoint[1] - prevPoint[1]);

    sampledPoints.push([pointX, pointY]);
    sampledTimings.push(sampleTime);

    currentTime += baseStep;
  }

  const trajectoryLength = Math.hypot(targetEnd.x - targetStart.x, targetEnd.y - targetStart.y);
  const sampledKnottedPoints = knotTrajectory(sampledPoints, targetStart, targetEnd, { random });
  const sampledJitteredPoints = jitterTrajectory(sampledKnottedPoints, trajectoryLength, { random });

  const dxTar = targetEnd.x - targetStart.x;
  const dyTar = targetEnd.y - targetStart.y;
  const lenTar = Math.hypot(dxTar, dyTar);

  const sampledMorphedPoints = morphTrajectory(
    sampledJitteredPoints,
    targetStart,
    targetEnd,
    dxTar,
    dyTar,
    lenTar,
  );

  return {
    points: sampledMorphedPoints.map(([x, y]) => ({ x, y })),
    timings: sampledTimings,
  };
}

/**
 * Generates a realistic mouse trajectory (points only).
 * @param {Point} targetStart - Starting point.
 * @param {Point} targetEnd - Ending point.
 * @param {TrajectoryOptions} [options] - Trajectory options.
 * @returns {Array<Point>}
 */
function trajectory(targetStart, targetEnd, options = {}) {
  const { points } = trajectoryWithTimings(targetStart, targetEnd, options);
  return points;
}

module.exports = {
  trajectory,
  trajectoryWithTimings,
  _internal: {
    loadTrajectories,
    findNearestTrajectory,
    findClosestTrajectory,
    morphTrajectory,
    jitterTrajectory,
    generateMiddleBiasedPoint,
    knotTrajectory,
    findTrajectory,
    randomGaussian,
    randomUniform,
    weightedChoice,
  },
};
