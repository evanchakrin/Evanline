import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyScaleCalibration,
  average,
  bufferDrift,
  buildArcPath,
  calibrationZeroValid,
  camberDeg,
  captureSeriesStats,
  clamp,
  clampAngle,
  computeSampleQuality,
  deltaContextMatch,
  fitPlane,
  flipSelfTest,
  gravityFromEuler,
  headingTrust,
  inclinationForMode,
  levelDeg,
  motionIsQuasiStatic,
  normalizeBaselinePoint,
  normalizeCalibrationMeta,
  normalizeCaptureSnapshot,
  normalizeMeasurement,
  pitchDeg,
  planeHeightForSide,
  polarPoint,
  poseFamilyForMode,
  poseOkForMode,
  poseOrientation,
  preferredOrientationForMode,
  scaleGainFromReference,
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

test('iOS-negated devicemotion vector agrees with the Euler source after onMotion sign fix', () => {
  // Stage 7 fix: iOS accelerationIncludingGravity is NEGATED relative to gravityFromEuler's
  // gravity-DIRECTION convention (flat screen-up reads z ~= +9.81, not -1). onMotion now stores
  // state.gravity = { x:-g.x, y:-g.y, z:-g.z }; this fixture replays that path so a future
  // regression (dropping the negation, or a pure-function sign flip) is caught off-device.
  const poses = [
    { beta: 0, gamma: 0 },     // flat screen-up
    { beta: 90, gamma: 0 },    // upright portrait
    { beta: 10, gamma: 0 },    // nose-up pitch
    { beta: -10, gamma: 0 },   // nose-down pitch
    { beta: 0, gamma: 10 },    // right level tilt
    { beta: 0, gamma: -10 },   // left level tilt
    { beta: 80, gamma: 5 },    // near-upright camber pose (Euler is weak here, signs must still agree)
  ];
  for (const pose of poses) {
    const euler = gravityFromEuler(pose);
    // Raw iOS reports the NEGATED vector (specific force, ~9.81 magnitude); onMotion negates it back.
    const rawIos = { x: -euler.x * 9.81, y: -euler.y * 9.81, z: -euler.z * 9.81 };
    const normalized = { x: -rawIos.x, y: -rawIos.y, z: -rawIos.z };
    // Magnitude differs (unit vs ~9.81) but every angle is an atan2 ratio, so it cancels.
    assert.equal(round2(camberDeg(normalized)), round2(camberDeg(euler)));
    assert.equal(round2(levelDeg(normalized)), round2(levelDeg(euler)));
    assert.equal(round2(pitchDeg(normalized)), round2(pitchDeg(euler)));
  }
  // The fix is load-bearing: an upright portrait phone normalizes to +y and must read +90 pitch;
  // the UNFIXED (raw iOS, -y) vector would read -90, proving the negation matters.
  assert.equal(round2(pitchDeg({ x: 0, y: 9.81, z: 0 })), 90);   // fixed: upright reads +90
  assert.equal(round2(pitchDeg({ x: 0, y: -9.81, z: 0 })), -90); // unfixed would read inverted -90
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

test('computeSampleQuality settles even when orientationOk is false (P0-4 pose is non-blocking)', () => {
  // A pose mismatch must NOT block a settle: it only costs confidence and is echoed for the UI.
  const inPose = computeSampleQuality(sampleQualityInputs({ orientationOk: true }));
  const outOfPose = computeSampleQuality(sampleQualityInputs({ orientationOk: false }));
  assert.equal(outOfPose.settled, true);
  assert.equal(outOfPose.orientationOk, false);
  assert.equal(inPose.orientationOk, true);
  // The pose mismatch still costs confidence (orientationPenalty), so it stays a visible hint.
  assert.ok(outOfPose.confidence < inPose.confidence);
});

test('poseFamilyForMode maps camber/toe to upright and level/pitch to flat', () => {
  assert.equal(poseFamilyForMode('camber'), 'upright');
  assert.equal(poseFamilyForMode('toe'), 'upright');
  assert.equal(poseFamilyForMode('level'), 'flat');
  assert.equal(poseFamilyForMode('pitch'), 'flat');
  // Unknown modes fall back to the flat family (same default as level/pitch).
  assert.equal(poseFamilyForMode('unknown'), 'flat');
});

test('poseOkForMode checks physical pose, allows normal angles, rejects wrong family', () => {
  // Upright phone (gravity along +y) is in pose for camber, out of pose for level.
  const upright = gravityFromEuler({ beta: 90, gamma: 0 });
  assert.equal(poseOkForMode('camber', upright), true);
  assert.equal(poseOkForMode('level', upright), false);
  // Flat phone (gravity along -z) is in pose for level/pitch, out of pose for camber.
  const flat = gravityFromEuler({ beta: 0, gamma: 0 });
  assert.equal(poseOkForMode('level', flat), true);
  assert.equal(poseOkForMode('pitch', flat), true);
  assert.equal(poseOkForMode('camber', flat), false);
  // A normal camber angle (upright phone tilted 30°) is still in pose (tolerance is generous).
  const tiltedUpright = gravityFromEuler({ beta: 60, gamma: 0 });
  assert.equal(poseOkForMode('camber', tiltedUpright), true);
  // Missing/zero gravity never blocks (advisory only).
  assert.equal(poseOkForMode('camber', null), true);
  assert.equal(poseOkForMode('camber', { x: 0, y: 0, z: 0 }), true);
});

test('poseOrientation derives the family from gravity, null when unavailable', () => {
  assert.equal(poseOrientation(gravityFromEuler({ beta: 90, gamma: 0 })), 'portrait');
  assert.equal(poseOrientation(gravityFromEuler({ beta: 0, gamma: 0 })), 'landscape');
  assert.equal(poseOrientation(null), null);
  assert.equal(poseOrientation({ x: 0, y: NaN, z: -1 }), null);
});

test('preferredOrientationForMode maps modes to their orientation family', () => {
  assert.equal(preferredOrientationForMode('camber'), 'portrait');
  assert.equal(preferredOrientationForMode('toe'), 'portrait');
  assert.equal(preferredOrientationForMode('level'), 'landscape');
  assert.equal(preferredOrientationForMode('pitch'), 'landscape');
});

test('flipSelfTest reports residual bias, asymmetry, and pass/fail for a 180° flip (P0-7)', () => {
  // A perfect inclinometer reads equal-and-opposite after the flip: +1.0 then -1.0.
  const perfect = flipSelfTest(1.0, -1.0);
  assert.equal(round2(perfect.residualBias), 0);
  assert.equal(round2(perfect.asymmetry), 0);
  assert.equal(round2(perfect.corrected), 1.0);
  assert.equal(perfect.passed, true);

  // A constant +0.5° sensor zero error does NOT flip, so it shows up as the residual bias and
  // pushes the pair out of symmetry: readings 1.5 and -0.5 -> bias 0.5, asymmetry 1.0.
  const biased = flipSelfTest(1.5, -0.5);
  assert.equal(round2(biased.residualBias), 0.5);
  assert.equal(round2(biased.asymmetry), 1.0);
  // The bias-cancelled true angle is still recovered: (1.5 - (-0.5)) / 2 = 1.0.
  assert.equal(round2(biased.corrected), 1.0);
  // 0.5° exceeds the default 0.2° tolerance, so the self-test fails.
  assert.equal(biased.passed, false);

  // A tiny bias inside tolerance passes.
  const withinTol = flipSelfTest(1.05, -0.95);
  assert.equal(round2(withinTol.residualBias), 0.05);
  assert.equal(withinTol.passed, true);

  // A custom (looser) tolerance flips the verdict for the same readings.
  assert.equal(flipSelfTest(1.5, -0.5, 0.6).passed, true);

  // Non-finite readings yield null fields and never pass.
  const missing = flipSelfTest(1.0, NaN);
  assert.equal(missing.residualBias, null);
  assert.equal(missing.asymmetry, null);
  assert.equal(missing.corrected, null);
  assert.equal(missing.passed, false);
});

test('calibrationZeroValid binds a stored zero to its capture orientation family (P1-3a)', () => {
  // A camber zero captured in portrait (its family) is valid.
  const portraitZero = { offset: 1.2, time: 't', orientation: 'portrait' };
  assert.equal(calibrationZeroValid('camber', portraitZero), true);
  // The same zero is invalid for level (which is landscape-family).
  assert.equal(calibrationZeroValid('level', portraitZero), false);
  // A camber zero captured in the WRONG family (landscape) is discarded.
  const landscapeZero = { offset: 1.2, time: 't', orientation: 'landscape' };
  assert.equal(calibrationZeroValid('camber', landscapeZero), false);
  // No stored calibration is never valid.
  assert.equal(calibrationZeroValid('camber', null), false);
  assert.equal(calibrationZeroValid('camber', { time: 't', orientation: 'portrait' }), false);
  // Optional currentOrientation also requires the live pose to match the family.
  assert.equal(calibrationZeroValid('camber', portraitZero, 'portrait'), true);
  assert.equal(calibrationZeroValid('camber', portraitZero, 'landscape'), false);
});

// --- P2-1: two-point scale calibration ----------------------------------------------------------

test('scaleGainFromReference derives gain = true/measured and rejects bad captures (P2-1)', () => {
  // Sensor reads 9.0° on a true 10.0° wedge -> gain 10/9 ~= 1.111.
  assert.ok(Math.abs(scaleGainFromReference(10, 9) - 10 / 9) < 1e-9);
  // Reading exactly true -> unity gain.
  assert.equal(scaleGainFromReference(10, 10), 1);
  // A measured value too close to zero is meaningless (division blows up) -> null.
  assert.equal(scaleGainFromReference(10, 0.1), null);
  // Non-finite inputs -> null.
  assert.equal(scaleGainFromReference(NaN, 9), null);
  assert.equal(scaleGainFromReference(10, NaN), null);
  // Implausible gains (outside [1/maxGain, maxGain]) are rejected so a fat-finger entry cannot
  // corrupt every reading: true 60° on a measured 1° would be gain 60.
  assert.equal(scaleGainFromReference(60, 1), null);
  // Opposite signs give a negative gain, which is rejected.
  assert.equal(scaleGainFromReference(-10, 9), null);
});

test('applyScaleCalibration applies (raw - offset) * gain with safe defaults (P2-1)', () => {
  // Default offset 0, gain 1 -> identity.
  assert.equal(applyScaleCalibration(5), 5);
  // Subtract the zero, then scale.
  assert.ok(Math.abs(applyScaleCalibration(11, 1, 1.1) - 11) < 1e-9); // (11-1)*1.1 = 11
  assert.ok(Math.abs(applyScaleCalibration(10, 0, 1.111) - 11.11) < 1e-9);
  // Null/non-finite raw stays null (preserves the no-reading pipeline).
  assert.equal(applyScaleCalibration(null), null);
  assert.equal(applyScaleCalibration(NaN, 1, 2), null);
  // A garbage gain (<=0 or non-finite) degrades to unity, never zeroes the reading.
  assert.equal(applyScaleCalibration(5, 0, 0), 5);
  assert.equal(applyScaleCalibration(5, 0, NaN), 5);
});

// --- P2-2: 4-corner least-squares plane fit -----------------------------------------------------

test('fitPlane recovers slopes and intercept for coplanar corners (P2-2)', () => {
  // z = 0.05*x + 0.10*y + 0.05 evaluated at the four unit-square corners.
  const plane = fitPlane({ FL: 0.10, FR: 0.20, RL: -0.10, RR: 0.00 });
  assert.ok(Math.abs(plane.a - 0.05) < 1e-9);
  assert.ok(Math.abs(plane.b - 0.10) < 1e-9);
  assert.ok(Math.abs(plane.c - 0.05) < 1e-9);
  assert.ok(plane.maxResidual < 1e-9);
  assert.equal(plane.coplanar, true);
  // planeHeightForSide reproduces each corner exactly.
  assert.ok(Math.abs(planeHeightForSide('FL', plane) - 0.10) < 1e-9);
  assert.ok(Math.abs(planeHeightForSide('RR', plane) - 0.00) < 1e-9);
});

test('fitPlane flags a non-coplanar datum via per-corner residuals (P2-2)', () => {
  // Push RR well off the plane (0.5° from the otherwise-coplanar 0.0). The least-squares fit
  // spreads the error, but the per-corner residual (δ/4 = 0.125) exceeds the default 0.08
  // tolerance so coplanar is false.
  const plane = fitPlane({ FL: 0.10, FR: 0.20, RL: -0.10, RR: 0.50 });
  assert.equal(plane.coplanar, false);
  assert.ok(plane.maxResidual > 0.08);
  // Residuals are keyed per corner so the UI can name the outlier.
  assert.ok(Object.keys(plane.residuals).length === 4);
});

test('fitPlane returns null with fewer than three points (P2-2)', () => {
  assert.equal(fitPlane({ FL: 0.1, FR: 0.2 }), null);
  assert.equal(fitPlane([{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }]), null);
  // Non-finite z values are dropped before the 3-point check.
  assert.equal(fitPlane({ FL: NaN, FR: 0.2, RL: 0.1 }), null);
});

test('planeHeightForSide is 0 without a usable plane or known corner (P2-2)', () => {
  assert.equal(planeHeightForSide('FL', null), 0);
  assert.equal(planeHeightForSide('FL', { a: NaN, b: 0, c: 0 }), 0);
  assert.equal(planeHeightForSide('ZZ', { a: 1, b: 1, c: 1 }), 0);
});

// --- P2-4: compass / heading awareness ----------------------------------------------------------

test('headingTrust trusts only an absolute compass heading with acceptable accuracy (P2-4)', () => {
  // Good Safari heading: absolute compass + tight accuracy -> trusted.
  const good = headingTrust({ absolute: true, webkitCompassHeading: 90, webkitCompassAccuracy: 10 });
  assert.equal(good.trusted, true);
  assert.equal(good.heading, 90);
  // Poor accuracy (indoor distortion) -> not trusted.
  const poor = headingTrust({ webkitCompassHeading: 90, webkitCompassAccuracy: 40 });
  assert.equal(poor.trusted, false);
  assert.equal(poor.reason, 'poor-accuracy');
  // Negative accuracy means interference/unknown -> not trusted.
  assert.equal(headingTrust({ webkitCompassHeading: 90, webkitCompassAccuracy: -1 }).trusted, false);
  // Absolute alpha but no compass heading -> usable orientation but not a trusted heading.
  const noHeading = headingTrust({ absolute: true });
  assert.equal(noHeading.trusted, false);
  assert.equal(noHeading.reason, 'no-heading');
  // Relative-only (no absolute, no compass) -> raw alpha must never be used as yaw.
  const relative = headingTrust({ absolute: false });
  assert.equal(relative.trusted, false);
  assert.equal(relative.reason, 'relative');
  // A compass heading with NO accuracy estimate is still trusted (Safari often omits accuracy).
  assert.equal(headingTrust({ webkitCompassHeading: 12 }).trusted, true);
});

// --- P2-3: delta context guard ------------------------------------------------------------------

test('deltaContextMatch flags mismatched calibration/orientation contexts (P2-3)', () => {
  const base = { offsetUsed: 0.2, gainUsed: 1.0, pose: 'portrait', deviceRefTime: 't1', fixtureId: 'f1' };
  // Identical context -> ok.
  assert.deepEqual(deltaContextMatch(base, { ...base }), { ok: true, reasons: [] });
  // Different zero offset.
  assert.deepEqual(deltaContextMatch(base, { ...base, offsetUsed: 0.5 }).reasons, ['zero offset']);
  // Different scale gain.
  assert.deepEqual(deltaContextMatch(base, { ...base, gainUsed: 1.1 }).reasons, ['scale gain']);
  // Different pose/orientation.
  assert.deepEqual(deltaContextMatch(base, { ...base, pose: 'landscape' }).reasons, ['orientation/pose']);
  // Different device reference + fixture stack up.
  const both = deltaContextMatch(base, { ...base, deviceRefTime: 't2', fixtureId: 'f2' });
  assert.equal(both.ok, false);
  assert.deepEqual(both.reasons, ['device reference', 'fixture']);
  // Missing one side never blocks (nothing to compare).
  assert.equal(deltaContextMatch(null, base).ok, true);
  // Legacy readings with absent stamps compare as "unknown" -> non-blocking.
  assert.equal(deltaContextMatch({ value: 1 }, { value: 2 }).ok, true);
  // Falls back to orientation when pose is absent.
  assert.equal(deltaContextMatch({ orientation: 'portrait' }, { orientation: 'landscape' }).ok, false);
});

// --- P2-5: persistence normalization / migration ------------------------------------------------

test('normalizeCaptureSnapshot tolerates legacy and stamps new context fields (P2-5)', () => {
  // Legacy snapshot: only value present. Missing fields coerce to the pre-P2 defaults.
  const legacy = normalizeCaptureSnapshot({ value: 1.23 }, 'NOW');
  assert.equal(legacy.value, 1.23);
  assert.equal(legacy.rawValue, null);      // P1-1 fallback path
  assert.equal(legacy.offsetUsed, null);
  assert.equal(legacy.gainUsed, 1);         // P2-1 unity default
  assert.equal(legacy.toleranceDeg, null);
  assert.equal(legacy.pose, null);
  assert.equal(legacy.fixtureId, '');
  assert.equal(legacy.time, 'NOW');
  // Full snapshot: every field carried through.
  const full = normalizeCaptureSnapshot({
    value: 0.85, rawValue: 1.05, offsetUsed: 0.2, gainUsed: 1.1, toleranceDeg: 0.04,
    orientation: 'landscape', pose: 'landscape', deviceRefTime: 'dt', fixtureId: 'fx', time: 't',
  });
  assert.equal(full.rawValue, 1.05);
  assert.equal(full.gainUsed, 1.1);
  assert.equal(full.pose, 'landscape');
  assert.equal(full.deviceRefTime, 'dt');
  assert.equal(full.fixtureId, 'fx');
  // A non-positive gain is treated as unity, never carried through as 0.
  assert.equal(normalizeCaptureSnapshot({ value: 1, gainUsed: 0 }).gainUsed, 1);
});

test('normalizeCalibrationMeta migrates v2 zero data and carries the optional scale (P2-5)', () => {
  // v2-style entry (no gain) loads unchanged with unity behaviour.
  const v2 = normalizeCalibrationMeta({ offset: 1.2, time: 't', orientation: 'portrait' });
  assert.equal(v2.offset, 1.2);
  assert.equal(v2.orientation, 'portrait');
  assert.equal(v2.gain, undefined);
  // An entry with no finite offset is "not zeroed".
  assert.equal(normalizeCalibrationMeta({ time: 't', orientation: 'portrait' }), null);
  assert.equal(normalizeCalibrationMeta(null), null);
  // A stored scale is carried forward; a bad orientation coerces to portrait.
  const scaled = normalizeCalibrationMeta({ offset: 0.5, time: 't', orientation: 'weird', gain: 1.1, gainReference: 10, gainTime: 'g' });
  assert.equal(scaled.orientation, 'portrait');
  assert.equal(scaled.gain, 1.1);
  assert.equal(scaled.gainReference, 10);
  assert.equal(scaled.gainTime, 'g');
  // A non-positive gain is dropped (behaves as unity).
  assert.equal(normalizeCalibrationMeta({ offset: 0.5, time: 't', orientation: 'portrait', gain: 0 }).gain, undefined);
});

test('normalizeMeasurement preserves context stamps and bounded history (P2-5)', () => {
  const m = normalizeMeasurement({
    mode: 'camber', side: 'FL', value: 1.0, offsetUsed: 0.2, gainUsed: 1.1,
    pose: 'portrait', deviceRefTime: 'd', fixtureId: 'f',
    history: [{ value: 0.9, time: 'h1' }, { value: 0.95, time: 'h2' }],
  }, 'NOW', 4);
  assert.equal(m.id, 'camber-FL');
  assert.equal(m.offsetUsed, 0.2);
  assert.equal(m.gainUsed, 1.1);
  assert.equal(m.pose, 'portrait');
  assert.equal(m.history.length, 2);
  assert.equal(m.history[0].value, 0.9);
  // Legacy reading: no stamps, no history -> nulls and empty history, still loads.
  const legacy = normalizeMeasurement({ mode: 'level', side: 'FR', value: 0.3 }, 'NOW');
  assert.equal(legacy.offsetUsed, null);
  assert.equal(legacy.gainUsed, null);
  assert.equal(legacy.history.length, 0);
  // History is bounded to maxHistory (keeps the most recent).
  const many = normalizeMeasurement({
    mode: 'pitch', side: 'RR', value: 5,
    history: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }, { value: 6 }],
  }, 'NOW', 3);
  assert.equal(many.history.length, 3);
  assert.deepEqual(many.history.map(h => h.value), [4, 5, 6]);
});

test('normalizeBaselinePoint coerces quality fields and defaults the time (P2-5)', () => {
  const p = normalizeBaselinePoint({ value: 0.1, confidence: 80, orientation: 'landscape' }, 'NOW');
  assert.equal(p.value, 0.1);
  assert.equal(p.confidence, 80);
  assert.equal(p.orientation, 'landscape');
  assert.equal(p.time, 'NOW');
  // Missing/garbage fields fall back to safe defaults.
  const bare = normalizeBaselinePoint({ value: 0.2 }, 'NOW');
  assert.equal(bare.confidence, 0);
  assert.equal(bare.orientation, 'portrait');
});
