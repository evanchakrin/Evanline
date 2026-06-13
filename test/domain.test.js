import test from 'node:test';
import assert from 'node:assert/strict';

import {
  average,
  buildArcPath,
  captureSeriesStats,
  clamp,
  clampAngle,
  computeSampleQuality,
  polarPoint,
  standardDeviation,
} from '../assets/js/domain.js';

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
