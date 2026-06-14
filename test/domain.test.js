import test from 'node:test';
import assert from 'node:assert/strict';

import {
  average,
  bufferDrift,
  buildArcPath,
  camberDeg,
  captureSeriesStats,
  clamp,
  clampAngle,
  computeSampleQuality,
  gravityFromEuler,
  inclinationForMode,
  levelDeg,
  motionIsQuasiStatic,
  pitchDeg,
  polarPoint,
  standardDeviation,
  toleranceHalfWidth,
} from '../assets/js/domain.js';

// Shared baseline inputs for computeSampleQuality so each test overrides just the field
// under test. A 6-sample tight buffer at now=2000 with settledStart=1000 settles by default.
function sampleQualityInputs(overrides = {}) {
  return {
    sampleBuffer: [0.02, 0.03, 0.01, 0.02, 0.02, 0.03, 0.01],
    orientationOk: true,
    calibrationSet: true,
    now: 2_000,
    settledStart: 1_000,
    alignedStart: 1_200,
    alignedThreshold: 0.3,
    minSampleCount: 6,
    settledRange: 0.18,
    settledStdDev: 0.08,
    settledHoldMs: 900,
    alignedHoldMs: 500,
    maxConfidenceBase: 98,
    rangePenalty: 260,
    stdDevPenalty: 420,
    orientationPenalty: 30,
    calibrationPenalty: 12,
    ...overrides,
  };
}

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 4), 4);
  assert.equal(clamp(-1, 0, 4), 0);
  assert.equal(clamp(2, 0, 4), 2);
});

test('average and standardDeviation compute expected values', () => {
  const values = [1, 2, 3, 4];
  assert.equal(average(values), 2.5);
  assert.equal(Number(standardDeviation(values).toFixed(3)), 1.118);
});

test('clampAngle uses symmetric range', () => {
  assert.equal(clampAngle(40, 30), 30);
  assert.equal(clampAngle(-40, 30), -30);
  assert.equal(clampAngle(15, 30), 15);
});

test('computeSampleQuality marks settled/aligned when stable long enough', () => {
  const sampleBuffer = [0.02, 0.03, 0.01, 0.02, 0.02, 0.03, 0.01];
  const result = computeSampleQuality({
    sampleBuffer,
    orientationOk: true,
    calibrationSet: true,
    now: 2_000,
    settledStart: 1_000,
    alignedStart: 1_200,
    alignedThreshold: 0.3,
    minSampleCount: 6,
    settledRange: 0.18,
    settledStdDev: 0.08,
    settledHoldMs: 900,
    alignedHoldMs: 500,
    maxConfidenceBase: 98,
    rangePenalty: 260,
    stdDevPenalty: 420,
    orientationPenalty: 30,
    calibrationPenalty: 12,
  });

  assert.equal(result.settled, true);
  assert.equal(result.aligned, true);
  assert.ok(result.confidence >= 5 && result.confidence <= 99);
});

test('computeSampleQuality resets timers when unstable', () => {
  const sampleBuffer = [0, 0.7, -0.6, 0.5, -0.4, 0.6];
  const result = computeSampleQuality({
    sampleBuffer,
    orientationOk: false,
    calibrationSet: false,
    now: 2_000,
    settledStart: 1_000,
    alignedStart: 1_200,
    alignedThreshold: 0.3,
    minSampleCount: 6,
    settledRange: 0.18,
    settledStdDev: 0.08,
    settledHoldMs: 900,
    alignedHoldMs: 500,
    maxConfidenceBase: 98,
    rangePenalty: 260,
    stdDevPenalty: 420,
    orientationPenalty: 30,
    calibrationPenalty: 12,
  });

  assert.equal(result.settled, false);
  assert.equal(result.aligned, false);
  assert.equal(result.settledStart, 0);
  assert.equal(result.alignedStart, 0);
});

test('polarPoint places points around the given centre', () => {
  // 0° in this scheme points "up" (angleDeg - 90 = -90 rad).
  const top = polarPoint(100, 100, 50, 0);
  assert.ok(Math.abs(top.x - 100) < 1e-9);
  assert.ok(Math.abs(top.y - 50) < 1e-9);

  const right = polarPoint(100, 100, 50, 90);
  assert.ok(Math.abs(right.x - 150) < 1e-9);
  assert.ok(Math.abs(right.y - 100) < 1e-9);
});

test('buildArcPath uses the large-arc flag for arcs >= 180 degrees', () => {
  const small = buildArcPath(0, 0, 10, -90, 0);
  assert.match(small, / 0 1 /);

  // Exactly 180 degrees should set the large-arc flag (regression guard).
  const half = buildArcPath(0, 0, 10, -90, 90);
  assert.match(half, / 1 1 /);

  const big = buildArcPath(0, 0, 10, -180, 90);
  assert.match(big, / 1 1 /);
});

test('captureSeriesStats returns null for empty input and aggregates otherwise', () => {
  assert.equal(captureSeriesStats([]), null);

  const stats = captureSeriesStats([{ value: 1 }, { value: 3 }, { value: 2 }]);
  assert.equal(stats.count, 3);
  assert.equal(stats.mean, 2);
  assert.equal(stats.range, 2);
  assert.equal(stats.latest.value, 2);
  assert.ok(stats.stdDev > 0);
});

// Add 0 to collapse -0 into 0 so strict equality against 0 holds.
const round2 = value => Number(value.toFixed(2)) + 0;

test('gravityFromEuler reconstructs the device-frame gravity direction', () => {
  // Flat phone (beta=0, gamma=0): gravity points straight out the back of the screen.
  const flat = gravityFromEuler({ beta: 0, gamma: 0 });
  assert.equal(round2(flat.x), 0);
  assert.equal(round2(flat.y), 0);
  assert.equal(round2(flat.z), -1);

  // Phone upright in portrait (beta=90): gravity now along +y.
  const upright = gravityFromEuler({ beta: 90, gamma: 0 });
  assert.equal(round2(upright.x), 0);
  assert.equal(round2(upright.y), 1);
  assert.equal(round2(upright.z), 0);

  // A 10deg roll (gamma) tips gravity into -x.
  const rolled = gravityFromEuler({ beta: 0, gamma: 10 });
  assert.ok(rolled.x < 0);
  assert.equal(round2(rolled.x), round2(-Math.sin(10 * Math.PI / 180)));

  assert.equal(gravityFromEuler({ beta: NaN, gamma: 0 }), null);
  assert.equal(gravityFromEuler({}), null);
});

test('levelDeg is zero when flat and signed for left/right tilt', () => {
  assert.equal(round2(levelDeg({ x: 0, y: 0, z: -1 })), 0);
  // Tilt right by 10deg about the device long axis: gravity gains -x.
  const right = gravityFromEuler({ beta: 0, gamma: 10 });
  assert.equal(round2(levelDeg(right)), -10);
  const left = gravityFromEuler({ beta: 0, gamma: -10 });
  assert.equal(round2(levelDeg(left)), 10);
  assert.equal(levelDeg({ x: 0, y: NaN, z: -1 }), null);
});

test('pitchDeg is zero when flat and signed for front/back tilt', () => {
  assert.equal(round2(pitchDeg({ x: 0, y: 0, z: -1 })), 0);
  // Nose up/down maps to beta; a 10deg beta tilt yields a 10deg pitch with sign.
  const up = gravityFromEuler({ beta: 10, gamma: 0 });
  assert.equal(round2(pitchDeg(up)), 10);
  const down = gravityFromEuler({ beta: -10, gamma: 0 });
  assert.equal(round2(pitchDeg(down)), -10);
  assert.equal(pitchDeg(null), null);
});

test('camberDeg reads tilt away from vertical for an upright phone', () => {
  // Perfectly upright portrait phone (gravity along +y) reads zero camber.
  assert.equal(round2(camberDeg({ x: 0, y: 1, z: 0 })), 0);
  // Upright phone leaned 10deg so gravity tips into +x => positive camber.
  const positive = camberDeg({
    x: Math.sin(10 * Math.PI / 180),
    y: Math.cos(10 * Math.PI / 180),
    z: 0,
  });
  assert.equal(round2(positive), 10);
  const negative = camberDeg({
    x: -Math.sin(10 * Math.PI / 180),
    y: Math.cos(10 * Math.PI / 180),
    z: 0,
  });
  assert.equal(round2(negative), -10);
  assert.equal(camberDeg(undefined), null);
});

test('inclinationForMode dispatches per mode and defaults to camber', () => {
  const tilted = { x: Math.sin(10 * Math.PI / 180), y: Math.cos(10 * Math.PI / 180), z: 0 };
  assert.equal(round2(inclinationForMode('camber', tilted)), 10);
  assert.equal(round2(inclinationForMode('level', gravityFromEuler({ beta: 0, gamma: 10 }))), -10);
  assert.equal(round2(inclinationForMode('pitch', gravityFromEuler({ beta: 10, gamma: 0 }))), 10);
  // Toe is handled in a later stage, so it returns null here.
  assert.equal(inclinationForMode('toe', tilted), null);
  // Unknown modes fall back to camber.
  assert.equal(round2(inclinationForMode('unknown', tilted)), 10);
  // Missing/non-finite gravity yields null regardless of mode.
  assert.equal(inclinationForMode('level', null), null);
  assert.equal(inclinationForMode('camber', { x: 0, y: NaN, z: 0 }), null);
});

test('bufferDrift measures half-to-half trend and ignores short buffers', () => {
  // Too few samples to split into two meaningful halves: no trend to report.
  assert.equal(bufferDrift([]), 0);
  assert.equal(bufferDrift([1, 2, 3]), 0);
  // Flat buffer: zero drift.
  assert.equal(bufferDrift([0.02, 0.02, 0.02, 0.02]), 0);
  // A clean ramp 0..7 splits into mean(0..3)=1.5 vs mean(4..7)=5.5 => drift 4.
  assert.equal(bufferDrift([0, 1, 2, 3, 4, 5, 6, 7]), 4);
});

test('toleranceHalfWidth returns k*sigma/sqrt(N) and discounts smoothed N', () => {
  // Raw buffer (rho ~= 0): N_eff = N, so half-width = 2 * 0.1 / sqrt(4) = 0.1.
  assert.equal(toleranceHalfWidth({ stdDev: 0.1, sampleCount: 4 }), 0.1);
  // Too little data to estimate a band.
  assert.equal(toleranceHalfWidth({ stdDev: 0.1, sampleCount: 1 }), null);
  assert.equal(toleranceHalfWidth({ stdDev: NaN, sampleCount: 4 }), null);
  // Smoothing inflates the band because autocorrelation lowers N_eff below N.
  const raw = toleranceHalfWidth({ stdDev: 0.1, sampleCount: 8 });
  const smoothed = toleranceHalfWidth({ stdDev: 0.1, sampleCount: 8, smoothingAlpha: 0.22 });
  assert.ok(smoothed > raw);
});

test('motionIsQuasiStatic gates on magnitude ratio and rotation, allowing unknown', () => {
  // No magnitude yet: do not block the Euler-only fallback.
  assert.equal(motionIsQuasiStatic({ gravityMagnitude: null }), true);
  // Resting at ~9.81 m/s^2 passes.
  assert.equal(motionIsQuasiStatic({ gravityMagnitude: 9.81 }), true);
  // Normalized ~1g also passes against the same expected via the ratio.
  assert.equal(motionIsQuasiStatic({ gravityMagnitude: 1, expectedMagnitude: 1 }), true);
  // A press/shove pushes |g| well off 1g and fails.
  assert.equal(motionIsQuasiStatic({ gravityMagnitude: 12 }), false);
  // Magnitude fine but high spin (deg/s) fails.
  assert.equal(motionIsQuasiStatic({ gravityMagnitude: 9.81, rotationRate: { alpha: 20, beta: 0, gamma: 0 } }), false);
  // Low spin passes.
  assert.equal(motionIsQuasiStatic({ gravityMagnitude: 9.81, rotationRate: { alpha: 1, beta: 1, gamma: 1 } }), true);
});

test('computeSampleQuality drift gate blocks settle on a slow ramp', () => {
  // Small instantaneous range/stdDev but a steady upward trend across the window.
  const ramp = [0.00, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
  const result = computeSampleQuality(sampleQualityInputs({
    sampleBuffer: ramp,
    settledRange: 0.2,
    settledStdDev: 0.1,
    driftTol: 0.03,
  }));
  assert.equal(result.settled, false);
  assert.ok(result.drift > 0.03);
  // Reports a +/- band off the raw buffer.
  assert.ok(Number.isFinite(result.toleranceDeg));
});

test('computeSampleQuality blocks settle when reading/motion/stream gates fail', () => {
  // Baseline: this buffer settles when every gate passes.
  assert.equal(computeSampleQuality(sampleQualityInputs()).settled, true);
  // P0-5: no real reading.
  assert.equal(computeSampleQuality(sampleQualityInputs({ readingOk: false })).settled, false);
  // P0-6: device is being moved/pressed.
  assert.equal(computeSampleQuality(sampleQualityInputs({ motionOk: false })).settled, false);
  // P1-6: sensor stream went stale.
  assert.equal(computeSampleQuality(sampleQualityInputs({ streamOk: false })).settled, false);
  // The gate flags are echoed back for the UI.
  const blocked = computeSampleQuality(sampleQualityInputs({ readingOk: false, motionOk: false, streamOk: false }));
  assert.equal(blocked.readingOk, false);
  assert.equal(blocked.motionOk, false);
  assert.equal(blocked.streamOk, false);
});
