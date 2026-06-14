import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRECISION_CONSTANTS,
  baselineSummary,
  baselineCompensationForSide,
  computeGuideState,
  precisionSummary,
  reversalFromCaptures,
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
  assert.equal(baselineCompensationForSide('FL', 'level', incomplete), 0);
});

// P1-2: known side means -> FL=0.10, FR=0.20, RL=-0.10, RR=0.00.
// overallMean=0.05, frontAvg=0.15, rearAvg=-0.05.
function planeSummary() {
  return baselineSummary({
    FL: [{ value: 0.10 }],
    FR: [{ value: 0.20 }],
    RL: [{ value: -0.10 }],
    RR: [{ value: 0.00 }],
  });
}

test('baselineCompensationForSide keeps the per-side deviation for level (P1-2)', () => {
  const summary = planeSummary();
  // FL mean 0.10 - overallMean 0.05 = 0.05.
  assert.ok(Math.abs(baselineCompensationForSide('FL', 'level', summary) - 0.05) < 1e-9);
  // RL mean -0.10 - overallMean 0.05 = -0.15.
  assert.ok(Math.abs(baselineCompensationForSide('RL', 'level', summary) - -0.15) < 1e-9);
});

test('baselineCompensationForSide EXCLUDES camber until the plane fit exists (P1-2)', () => {
  // Subtracting a level-plane height from an upright camber reading is dimensionally wrong.
  const summary = planeSummary();
  assert.equal(baselineCompensationForSide('FL', 'camber', summary), 0);
  assert.equal(baselineCompensationForSide('RR', 'camber', summary), 0);
});

test('baselineCompensationForSide adds front/rear pitch compensation (P1-2)', () => {
  const summary = planeSummary();
  // Front sides share frontAvg 0.15 - overallMean 0.05 = 0.10.
  assert.ok(Math.abs(baselineCompensationForSide('FL', 'pitch', summary) - 0.10) < 1e-9);
  assert.ok(Math.abs(baselineCompensationForSide('FR', 'pitch', summary) - 0.10) < 1e-9);
  // Rear sides share rearAvg -0.05 - overallMean 0.05 = -0.10.
  assert.ok(Math.abs(baselineCompensationForSide('RL', 'pitch', summary) - -0.10) < 1e-9);
  assert.ok(Math.abs(baselineCompensationForSide('RR', 'pitch', summary) - -0.10) < 1e-9);
});

test('baselineCompensationForSide keeps toe excluded (P1-2)', () => {
  const summary = planeSummary();
  assert.equal(baselineCompensationForSide('FL', 'toe', summary), 0);
});

test('reversalFromCaptures cancels the shared zero from raw means (P1-1)', () => {
  const result = reversalFromCaptures({
    forward: [{ value: 0.85, rawValue: 1.05, offsetUsed: 0.2 }, { value: 0.85, rawValue: 1.05, offsetUsed: 0.2 }],
    reverse: [{ value: -1.15, rawValue: -0.95, offsetUsed: 0.2 }],
  });
  assert.ok(Math.abs(result.reversalCorrectedValue - 1.0) < 1e-9);
  assert.ok(Math.abs(result.reversalBias - 0.05) < 1e-9);
  assert.equal(result.offsetConflict, false);
});

test('reversalFromCaptures flags an offset conflict and a forward-only zeroed value (P1-1)', () => {
  const conflict = reversalFromCaptures({
    forward: [{ value: 0.85, rawValue: 1.05, offsetUsed: 0.2 }],
    reverse: [{ value: -1.45, rawValue: -0.95, offsetUsed: 0.5 }],
  });
  assert.equal(conflict.offsetConflict, true);

  const forwardOnly = reversalFromCaptures({
    forward: [{ value: 0.85, rawValue: 1.05, offsetUsed: 0.2 }],
    reverse: [],
  });
  // No reverse to cancel against -> forward-only value is the display-zeroed raw mean.
  assert.ok(Math.abs(forwardOnly.forwardZeroed - 0.85) < 1e-9);
  assert.equal(forwardOnly.reversalBias, null);
  assert.equal(forwardOnly.offsetConflict, false);
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

test('precisionSummary cancels reversal bias from RAW means even with a shared zero (P1-1)', () => {
  const baseline = baselineSummary({
    FL: [{ value: 0 }],
    FR: [{ value: 0 }],
    RL: [{ value: 0 }],
    RR: [{ value: 0 }],
  });
  // P1-1: captures now carry the RAW (pre-calibration) angle and the offset that was active.
  // A shared 0.2° zero is baked into offsetUsed on every capture; the raw means are true+bias.
  // corrected=(F_raw-R_raw)/2 and bias=(F_raw+R_raw)/2 must ignore the offset entirely.
  const fwd = v => ({ value: v - 0.2, rawValue: v, offsetUsed: 0.2 });
  const rev = v => ({ value: v - 0.2, rawValue: v, offsetUsed: 0.2 });
  const captures = {
    'camber:FL': {
      mode: 'camber',
      side: 'FL',
      // True angle 1.0° + 0.05° mounting bias. P1-5: a verdict needs >= 5 forward captures.
      forward: [fwd(1.05), fwd(1.04), fwd(1.06), fwd(1.05), fwd(1.05)],
      // Reversed flips the true angle sign but keeps the same +0.05 mounting bias.
      reverse: [rev(-0.95), rev(-0.96)],
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
  assert.equal(summary.offsetConflict, false);
  assert.ok(Math.abs(summary.reversalBias - 0.05) < 0.01);
  assert.ok(Math.abs(summary.reversalCorrectedValue - 1.0) < 0.01);
  assert.ok(Number.isFinite(summary.finalValue));
  // P1-5: n and the standard-error band travel with the verdict.
  assert.equal(summary.n, 5);
  assert.ok(Number.isFinite(summary.toleranceDeg));
});

test('precisionSummary cancellation is unaffected by the size of the shared zero (P1-1)', () => {
  const baseline = baselineSummary({
    FL: [{ value: 0 }], FR: [{ value: 0 }], RL: [{ value: 0 }], RR: [{ value: 0 }],
  });
  // Same raw readings as above but with a much larger shared 5° zero. Because reversal works on
  // the RAW means, corrected/bias are identical — the zero provably cancels in the difference.
  const cap = v => ({ value: v - 5, rawValue: v, offsetUsed: 5 });
  const captures = {
    'camber:FL': {
      mode: 'camber',
      side: 'FL',
      forward: [cap(1.05), cap(1.04), cap(1.06), cap(1.05), cap(1.05)],
      reverse: [cap(-0.95), cap(-0.96)],
    },
  };
  const summary = precisionSummary({ mode: 'camber', side: 'FL', captures, baseline, fixture: { reversible: true } });
  assert.ok(Math.abs(summary.reversalBias - 0.05) < 0.01);
  assert.ok(Math.abs(summary.reversalCorrectedValue - 1.0) < 0.01);
});

test('precisionSummary refuses to save when the operator re-zeroed between flips (P1-1)', () => {
  const baseline = baselineSummary({
    FL: [{ value: 0 }], FR: [{ value: 0 }], RL: [{ value: 0 }], RR: [{ value: 0 }],
  });
  // Forward captured with a 0.2° zero, reverse re-zeroed to 0.5° -> offsetConflict.
  const captures = {
    'camber:FL': {
      mode: 'camber',
      side: 'FL',
      forward: [
        { value: 0.85, rawValue: 1.05, offsetUsed: 0.2 },
        { value: 0.84, rawValue: 1.04, offsetUsed: 0.2 },
        { value: 0.86, rawValue: 1.06, offsetUsed: 0.2 },
        { value: 0.85, rawValue: 1.05, offsetUsed: 0.2 },
        { value: 0.85, rawValue: 1.05, offsetUsed: 0.2 },
      ],
      reverse: [
        { value: -1.45, rawValue: -0.95, offsetUsed: 0.5 },
        { value: -1.46, rawValue: -0.96, offsetUsed: 0.5 },
      ],
    },
  };
  const summary = precisionSummary({ mode: 'camber', side: 'FL', captures, baseline, fixture: { reversible: true } });
  assert.equal(summary.offsetConflict, true);
  assert.equal(summary.readyToSave, false);
  assert.equal(summary.verdict, 'Re-zeroed between flips');
  // The raw-based cancellation itself is still computed (corrected ignores the offsets entirely).
  assert.ok(Math.abs(summary.reversalCorrectedValue - 1.0) < 0.01);
});

test('precisionSummary forward-only value applies the stored zero (P1-1)', () => {
  const baseline = baselineSummary({
    FL: [{ value: 0 }], FR: [{ value: 0 }], RL: [{ value: 0 }], RR: [{ value: 0 }],
  });
  // No reverse set: the forward-only value is the display-zeroed reading (raw - offset).
  const captures = {
    'camber:FL': {
      mode: 'camber',
      side: 'FL',
      forward: [
        { value: 0.85, rawValue: 1.05, offsetUsed: 0.2 },
        { value: 0.84, rawValue: 1.04, offsetUsed: 0.2 },
        { value: 0.86, rawValue: 1.06, offsetUsed: 0.2 },
        { value: 0.85, rawValue: 1.05, offsetUsed: 0.2 },
        { value: 0.85, rawValue: 1.05, offsetUsed: 0.2 },
      ],
      reverse: [],
    },
  };
  const summary = precisionSummary({ mode: 'camber', side: 'FL', captures, baseline, fixture: { reversible: false } });
  assert.equal(summary.offsetConflict, false);
  // raw mean ~1.05, offset 0.2 -> ~0.85 displayed.
  assert.ok(Math.abs(summary.forwardOnlyValue - 0.85) < 0.01);
  assert.ok(Math.abs(summary.reversalCorrectedValue - 0.85) < 0.01);
});

test('precisionSummary tolerates legacy captures saved before rawValue existed (P1-1)', () => {
  const baseline = baselineSummary({
    FL: [{ value: 0 }], FR: [{ value: 0 }], RL: [{ value: 0 }], RR: [{ value: 0 }],
  });
  // Old data: only `value` present. reversalFromCaptures falls back to value, behaving as the
  // pre-P1-1 shared-offset path so loading historical sessions still produces a verdict.
  const captures = {
    'camber:FL': {
      mode: 'camber',
      side: 'FL',
      forward: [{ value: 1.05 }, { value: 1.04 }, { value: 1.06 }, { value: 1.05 }, { value: 1.05 }],
      reverse: [{ value: -0.95 }, { value: -0.96 }],
    },
  };
  const summary = precisionSummary({ mode: 'camber', side: 'FL', captures, baseline, fixture: { reversible: true } });
  assert.equal(summary.offsetConflict, false);
  assert.ok(Math.abs(summary.reversalBias - 0.05) < 0.01);
  assert.ok(Math.abs(summary.reversalCorrectedValue - 1.0) < 0.01);
  assert.equal(summary.readyToSave, true);
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
