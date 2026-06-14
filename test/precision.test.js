import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRECISION_CONSTANTS,
  baselineSummary,
  baselineCompensationForSide,
  computeGuideState,
  precisionSummary,
} from '../assets/js/precision.js';

const guideCopy = {
  placement: 'Placement: Flush to wheel face, screen outward',
  orientation: 'Portrait',
  calibration: 'Zero against a known vertical or repeatable reference before reading camber.',
};

function baseGuideInputs(overrides = {}) {
  return {
    sensorsAvailable: true,
    notice: null,
    workflow: 'quick',
    mode: 'camber',
    selectedSide: 'FL',
    deviceProfileSet: false,
    fixtureSelected: false,
    calibrationSet: true,
    levelPrepared: true,
    // P0-4: orientationOk is the physical-pose hint; poseFamilyLabel names the expected pose.
    orientationOk: true,
    poseFamilyLabel: 'Portrait',
    settled: true,
    baseline: { complete: false, completedSides: 0, label: 'Incomplete' },
    precision: { forward: null, reverse: null, needsReverse: false, verdict: 'Need more captures', repeatabilityScore: 50 },
    modeLabel: 'Camber Angle',
    guide: guideCopy,
    ...overrides,
  };
}

test('baselineSummary marks incomplete plane until all four sides are captured', () => {
  const partial = baselineSummary({ FL: [{ value: 0 }], FR: [{ value: 0 }] });
  assert.equal(partial.completedSides, 2);
  assert.equal(partial.complete, false);
  assert.equal(partial.label, 'Incomplete');
});

test('baselineSummary reports Trusted when spread is tight across all sides', () => {
  const points = {
    FL: [{ value: 0 }, { value: 0.01 }],
    FR: [{ value: 0.02 }, { value: 0.01 }],
    RL: [{ value: -0.01 }, { value: 0 }],
    RR: [{ value: 0.01 }, { value: 0 }],
  };
  const summary = baselineSummary(points);
  assert.equal(summary.complete, true);
  assert.equal(summary.label, 'Trusted');
  assert.equal(summary.tone, 'good');
});

test('baselineCompensationForSide returns 0 unless baseline is complete', () => {
  const incomplete = baselineSummary({ FL: [{ value: 0.2 }] });
  assert.equal(baselineCompensationForSide('FL', 'camber', incomplete), 0);
});

test('precisionSummary blocks save when forward captures are missing', () => {
  const summary = precisionSummary({
    mode: 'camber',
    side: 'FL',
    captures: {},
    baseline: baselineSummary({}),
    fixture: { reversible: false },
  });
  assert.equal(summary.readyToSave, false);
  assert.equal(summary.verdict, 'Need more captures');
});

test('precisionSummary cancels reversal bias and reports a final value when ready', () => {
  const baseline = baselineSummary({
    FL: [{ value: 0 }],
    FR: [{ value: 0 }],
    RL: [{ value: 0 }],
    RR: [{ value: 0 }],
  });
  const captures = {
    'camber:FL': {
      mode: 'camber',
      side: 'FL',
      // P1-5: a verdict now needs at least MIN_PRECISION_CAPTURES_VERDICT (5) forward captures.
      forward: [{ value: 1.05 }, { value: 1.04 }, { value: 1.06 }, { value: 1.05 }, { value: 1.05 }],
      // Reversed captures flip sign of the true angle but keep the same +0.05 mounting bias.
      reverse: [{ value: -0.95 }, { value: -0.96 }],
    },
  };
  const summary = precisionSummary({
    mode: 'camber',
    side: 'FL',
    captures,
    baseline,
    fixture: { reversible: true },
  });
  assert.equal(summary.readyToSave, true);
  assert.ok(Math.abs(summary.reversalBias - 0.05) < 0.01);
  assert.ok(Math.abs(summary.reversalCorrectedValue - 1.0) < 0.01);
  assert.ok(Number.isFinite(summary.finalValue));
  // P1-5: n and the standard-error band travel with the verdict.
  assert.equal(summary.n, 5);
  assert.ok(Number.isFinite(summary.toleranceDeg));
});

test('precisionSummary blocks the verdict until the minimum capture count is met', () => {
  const baseline = baselineSummary({
    FL: [{ value: 0 }], FR: [{ value: 0 }], RL: [{ value: 0 }], RR: [{ value: 0 }],
  });
  // Three clean forward captures clear MIN_PRECISION_CAPTURES_READY but not the verdict floor.
  const captures = {
    'camber:FL': {
      mode: 'camber',
      side: 'FL',
      forward: [{ value: 1.05 }, { value: 1.04 }, { value: 1.06 }],
      reverse: [],
    },
  };
  const summary = precisionSummary({
    mode: 'camber',
    side: 'FL',
    captures,
    baseline,
    fixture: { reversible: false },
  });
  assert.equal(summary.readyToSave, false);
  assert.equal(summary.verdict, 'Need more captures');
});

test('computeGuideState surfaces sensor permission first', () => {
  const result = computeGuideState(baseGuideInputs({ sensorsAvailable: false }));
  assert.match(result.warning, /Enable motion access/);
});

test('computeGuideState surfaces active notice ahead of workflow steps', () => {
  const result = computeGuideState(baseGuideInputs({
    notice: { text: 'something happened', tone: 'good' },
  }));
  assert.equal(result.warning, 'something happened');
  assert.equal(result.tone, 'good');
});

test('computeGuideState routes precision workflow to device reference first', () => {
  const result = computeGuideState(baseGuideInputs({
    workflow: 'precision',
    deviceProfileSet: false,
  }));
  assert.match(result.title, /device reference/i);
});

test('computeGuideState reaches the save step once everything is satisfied', () => {
  const result = computeGuideState(baseGuideInputs({
    settled: true,
    workflow: 'quick',
  }));
  assert.match(result.title, /Save the averaged reading/);
  assert.equal(result.tone, 'good');
});

test('computeGuideState keeps a pose mismatch non-blocking (P0-4)', () => {
  // A pose mismatch must NOT preempt the settle/save flow; it only appends a warning and
  // downgrades a 'good' tone to 'warn'. The user can still reach (and act on) the save step.
  const result = computeGuideState(baseGuideInputs({
    settled: true,
    workflow: 'quick',
    orientationOk: false,
  }));
  assert.match(result.title, /Save the averaged reading/);
  assert.match(result.warning, /not in the .* pose/i);
  assert.equal(result.tone, 'warn');
});

test('computeGuideState appends the pose hint while still settling (P0-4)', () => {
  // Even before settling, the pose hint rides along with the Hold-steady step rather than
  // replacing it with a blocking "Rotate" step.
  const result = computeGuideState(baseGuideInputs({
    settled: false,
    workflow: 'quick',
    orientationOk: false,
  }));
  assert.match(result.title, /Hold steady/);
  assert.match(result.warning, /not in the .* pose/i);
});

test('PRECISION_CONSTANTS keep the documented quality thresholds', () => {
  assert.equal(PRECISION_CONSTANTS.ADJUSTMENT_QUALITY_THRESHOLD, 88);
  assert.equal(PRECISION_CONSTANTS.COMPARISON_QUALITY_THRESHOLD, 68);
});

test('PRECISION_CONSTANTS keep readiness in step with the displayed target', () => {
  // P1-5: readiness must equal the displayed forward target, and a verdict needs a
  // meaningful minimum (>= 5) captures.
  assert.equal(PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_READY, PRECISION_CONSTANTS.FORWARD_CAPTURE_TARGET);
  assert.equal(PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_VERDICT, 5);
  assert.ok(PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_VERDICT >= 5);
});
