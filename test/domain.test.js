import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyScaleCalibration,
  average,
  bufferDrift,
  buildArcPath,
  calibrationZeroValid,
  camberDeg,
  casterFromCamberSwing,
  casterBandDeg,
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
  toeAngleFromOffset,
  toeAngleToLinear,
  toeReadUncertaintyDeg,
  toeRunoutDisagreement,
  computeToeWizardResult,
  computeToeStringBoxResult,
  toleranceHalfWidth,
  totalToeFromPlates,
  perWheelFromTotal,
  thrustAngle,
  linearToToeAngle,
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
  // A real upright portrait phone (top up) has gravity pointing at its BOTTOM (device -y), so
  // camberDeg centers on -g.y and a plumb phone reads zero (NOT the ~180° the old atan2(x,y) gave,
  // which sat on the branch cut and could never settle).
  assert.equal(round2(camberDeg({ x: 0, y: -1, z: 0 })), 0);
  // Top leaned 10deg so gravity tips into +x => positive camber.
  const positive = camberDeg({
    x: Math.sin(10 * Math.PI / 180),
    y: -Math.cos(10 * Math.PI / 180),
    z: 0,
  });
  assert.equal(round2(positive), 10);
  const negative = camberDeg({
    x: -Math.sin(10 * Math.PI / 180),
    y: -Math.cos(10 * Math.PI / 180),
    z: 0,
  });
  assert.equal(round2(negative), -10);
  assert.equal(camberDeg(undefined), null);
});

test('inclinationForMode dispatches per mode and defaults to camber', () => {
  // Upright camber pose: gravity along -y (see camberDeg), leaned 10deg into +x.
  const tilted = { x: Math.sin(10 * Math.PI / 180), y: -Math.cos(10 * Math.PI / 180), z: 0 };
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

test('computeSampleQuality reports the specific blockedBy reason for the UI', () => {
  // Settled => no block reason.
  assert.equal(computeSampleQuality(sampleQualityInputs()).blockedBy, null);
  // Reasons are ordered most- to least-fundamental.
  assert.equal(computeSampleQuality(sampleQualityInputs({ readingOk: false })).blockedBy, 'no-reading');
  assert.equal(computeSampleQuality(sampleQualityInputs({ streamOk: false })).blockedBy, 'stream-stale');
  assert.equal(computeSampleQuality(sampleQualityInputs({ motionOk: false })).blockedBy, 'motion');
  assert.equal(computeSampleQuality(sampleQualityInputs({ sampleBuffer: [0.01, 0.02] })).blockedBy, 'collecting');
  // A wide spread reports 'spread'; the timer-only wait reports 'holding'.
  assert.equal(computeSampleQuality(sampleQualityInputs({ sampleBuffer: [0, 0.5, -0.5, 0.4, -0.4, 0.45] })).blockedBy, 'spread');
  assert.equal(computeSampleQuality(sampleQualityInputs({ settledStart: 0, now: 1_000 })).blockedBy, 'holding');
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

test('normalizeMeasurement round-trips a geometric toe reading and its toe stamps', () => {
  const toe = normalizeMeasurement({
    mode: 'toe', side: 'FL', value: 0.12, workflow: 'geometric',
    toeMethod: 'plates', toeUnits: 'mm', toeDiameter: 381, toeSpecDiameter: 381,
    toeTotal: 0.12, toePerWheel: 0.06, toeLinear: 0.8,
    toeSymmetryAssumed: true, toeRunoutDisagreement: 0.04, toeRunoutFault: false,
  }, 'NOW');
  // The 'geometric' workflow survives (no longer coerced to 'quick').
  assert.equal(toe.workflow, 'geometric');
  assert.equal(toe.toeMethod, 'plates');
  assert.equal(toe.toeUnits, 'mm');
  assert.equal(toe.toeDiameter, 381);
  assert.equal(toe.toeTotal, 0.12);
  assert.equal(toe.toePerWheel, 0.06);
  assert.equal(toe.toeSymmetryAssumed, true);
  assert.equal(toe.toeRunoutDisagreement, 0.04);
  assert.equal(toe.toeRunoutFault, false);
  // Stage 3: a PRECISION string-box reading round-trips its method, thrust, and no-symmetry flag.
  const sb = normalizeMeasurement({
    mode: 'toe', side: 'RL', value: 0.05, workflow: 'geometric',
    toeMethod: 'string-box', toeUnits: 'mm', toeDiameter: 381, toeSpecDiameter: 381,
    toeTotal: 0.1, toePerWheel: 0.05, toeLinear: 0.7, toeThrust: 0.03,
    toeSymmetryAssumed: false,
  }, 'NOW');
  assert.equal(sb.toeMethod, 'string-box');
  assert.equal(sb.toeThrust, 0.03);
  assert.equal(sb.toeSymmetryAssumed, false);
  // The thrust stamp is null on the plates reading above (and on non-toe readings).
  assert.equal(toe.toeThrust, null);
  // A legacy sensor reading carries null/false for every toe field and keeps its workflow.
  const legacy = normalizeMeasurement({ mode: 'camber', side: 'FR', value: 1.0, workflow: 'precision' }, 'NOW');
  assert.equal(legacy.workflow, 'precision');
  assert.equal(legacy.toeMethod, null);
  assert.equal(legacy.toeThrust, null);
  assert.equal(legacy.toeSymmetryAssumed, false);
  assert.equal(legacy.toeRunoutFault, false);
  // An unknown workflow string still falls back to 'quick'.
  assert.equal(normalizeMeasurement({ mode: 'level', side: 'RL', value: 0, workflow: 'bogus' }, 'NOW').workflow, 'quick');
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

// --- GEOMETRIC TOE: pure math + uncertainty -----------------------------------------------------

test('toeAngleFromOffset hits the self-check constants and is toe-in positive', () => {
  // Self-check: "1 inch = 2 degrees" rule. atan(1 / 28.648 in) ~= 1.999 deg.
  assert.ok(Math.abs(toeAngleFromOffset(1, 0, 28.648) - 1.999) < 1e-3);
  // Self-check: 1 mm offset on a 15 in (381 mm) wheel ~= 0.150 deg.
  assert.ok(Math.abs(toeAngleFromOffset(1, 0, 381) - 0.150) < 1e-3);
  // Toe-in sign: rear edge wider than front (rear > front) => POSITIVE.
  assert.ok(toeAngleFromOffset(2, 1, 28.648) > 0);
  // Toe-out: rear < front => NEGATIVE.
  assert.ok(toeAngleFromOffset(1, 2, 28.648) < 0);
  // Equal front/rear is exactly zero toe.
  assert.equal(toeAngleFromOffset(1.5, 1.5, 28.648), 0);
  // 1/D scaling: doubling the reference diameter halves the angle for the same offset (small-offset
  // limit where atan is near-linear, so the 1/D relation is clean; atan's curvature only shows at
  // larger ratios).
  const small = toeAngleFromOffset(0.01, 0, 14);
  const big = toeAngleFromOffset(0.01, 0, 28);
  assert.ok(Math.abs(small - 2 * big) < 1e-6);
  // Null guards: non-finite inputs and non-positive diameter.
  assert.equal(toeAngleFromOffset(NaN, 0, 28.648), null);
  assert.equal(toeAngleFromOffset(1, NaN, 28.648), null);
  assert.equal(toeAngleFromOffset(1, 0, 0), null);
  assert.equal(toeAngleFromOffset(1, 0, -10), null);
});

test('totalToeFromPlates gives total axle toe with toe-in positive', () => {
  // R (rear gap) > F (front gap) => toe-in => positive. 1 in over a 28.648 in plate span = 1.999 deg.
  assert.ok(Math.abs(totalToeFromPlates(1, 0, 28.648) - 1.999) < 1e-3);
  // R < F => toe-out => negative.
  assert.ok(totalToeFromPlates(0, 1, 28.648) < 0);
  // Equal spans => zero total toe.
  assert.equal(totalToeFromPlates(2, 2, 28.648), 0);
  // Null guards.
  assert.equal(totalToeFromPlates(NaN, 0, 28.648), null);
  assert.equal(totalToeFromPlates(1, 0, 0), null);
  assert.equal(totalToeFromPlates(1, 0, -5), null);
});

test('perWheelFromTotal splits total toe under the symmetry assumption', () => {
  assert.equal(perWheelFromTotal(2.0), 1.0);
  assert.equal(perWheelFromTotal(-0.3), -0.15);
  assert.equal(perWheelFromTotal(0), 0);
  assert.equal(perWheelFromTotal(NaN), null);
});

test('thrustAngle is half the rear left-right toe difference (+ points left)', () => {
  // RL toe-in more than RR => thrust line points left => positive.
  assert.equal(thrustAngle(0.4, 0.2), 0.1);
  // Symmetric rear toe => zero thrust.
  assert.equal(thrustAngle(0.3, 0.3), 0);
  // RR greater => negative (points right).
  assert.equal(thrustAngle(0.1, 0.5), -0.2);
  assert.equal(thrustAngle(NaN, 0.2), null);
  assert.equal(thrustAngle(0.4, NaN), null);
});

test('toeAngleToLinear and linearToToeAngle round-trip and hit the self-check constants', () => {
  // Self-check: 1.999 deg on a 28.648 in spec diameter is ~1 inch of linear toe.
  assert.ok(Math.abs(toeAngleToLinear(1.999, 28.648) - 1) < 1e-3);
  // Inverse: atan(1 / 28.648) ~= 1.999 deg ("1 inch = 2 degrees").
  assert.ok(Math.abs(linearToToeAngle(1, 28.648) - 1.999) < 1e-3);
  // Inverse: 1 mm on a 15 in (381 mm) wheel ~= 0.150 deg.
  assert.ok(Math.abs(linearToToeAngle(1, 381) - 0.150) < 1e-3);
  // Round-trip angle -> linear -> angle.
  const angle = 0.42;
  const linear = toeAngleToLinear(angle, 30);
  assert.ok(Math.abs(linearToToeAngle(linear, 30) - angle) < 1e-9);
  // Sign is preserved through both directions.
  assert.ok(toeAngleToLinear(-0.5, 30) < 0);
  assert.ok(linearToToeAngle(-1, 30) < 0);
  // Null guards on both helpers.
  assert.equal(toeAngleToLinear(NaN, 30), null);
  assert.equal(toeAngleToLinear(1, 0), null);
  assert.equal(toeAngleToLinear(1, -30), null);
  assert.equal(linearToToeAngle(NaN, 30), null);
  assert.equal(linearToToeAngle(1, 0), null);
  assert.equal(linearToToeAngle(1, -30), null);
});

test('toeReadUncertaintyDeg propagates u/D with sqrt(2) for the differential and k=2', () => {
  // Differential default: 2 * (0.8 / 381) * sqrt(2) * 180/PI for a 0.8 mm read on a 15 in wheel.
  const expected = 2 * (0.8 / 381) * Math.SQRT2 * 180 / Math.PI;
  assert.ok(Math.abs(toeReadUncertaintyDeg(0.8, 381) - expected) < 1e-12);
  // The differential band is exactly sqrt(2) times the single-read band.
  const diff = toeReadUncertaintyDeg(0.8, 381, true);
  const single = toeReadUncertaintyDeg(0.8, 381, false);
  assert.ok(Math.abs(diff / single - Math.SQRT2) < 1e-12);
  // 1/D scaling: doubling the diameter halves the band.
  const small = toeReadUncertaintyDeg(0.8, 200);
  const big = toeReadUncertaintyDeg(0.8, 400);
  assert.ok(Math.abs(small - 2 * big) < 1e-12);
  // Band is always positive for a positive read uncertainty.
  assert.ok(toeReadUncertaintyDeg(0.8, 381) > 0);
  // Null guards.
  assert.equal(toeReadUncertaintyDeg(NaN, 381), null);
  assert.equal(toeReadUncertaintyDeg(0.8, 0), null);
  assert.equal(toeReadUncertaintyDeg(0.8, -381), null);
});

test('toeRunoutDisagreement flags read-pair disagreement and refuses a single read', () => {
  // Both finite + within threshold => ready, does not exceed.
  const ok = toeRunoutDisagreement(0.20, 0.30, 0.25);
  assert.equal(ok.ready, true);
  assert.ok(Math.abs(ok.disagreement - 0.10) < 1e-12);
  assert.equal(ok.exceeds, false);
  // Beyond threshold => exceeds (runout/seating fault).
  const bad = toeRunoutDisagreement(0.10, 0.50, 0.25);
  assert.equal(bad.exceeds, true);
  assert.ok(Math.abs(bad.disagreement - 0.40) < 1e-12);
  // A missing second read is not ready (single-read refusal).
  const single = toeRunoutDisagreement(0.20, NaN, 0.25);
  assert.equal(single.ready, false);
  assert.equal(single.disagreement, null);
  assert.equal(single.exceeds, false);
  // Default threshold is 0.25 deg.
  assert.equal(toeRunoutDisagreement(0, 0.3).exceeds, true);
  assert.equal(toeRunoutDisagreement(0, 0.2).exceeds, false);
});

test('computeToeWizardResult refuses a single read and needs a positive diameter', () => {
  const setup = { method: 'plates', diameter: 28.648, specDiameter: 28.648, readUncertainty: 0.8 };
  // No diameter => not ready, with guidance.
  const noD = computeToeWizardResult({ ...setup, diameter: 0 }, [{ front: 0, rear: 1 }, { front: 0, rear: 1 }]);
  assert.equal(noD.ready, false);
  assert.match(noD.reason, /reference diameter/);
  // Zero pairs => not ready (asks for the first pair).
  const none = computeToeWizardResult(setup, []);
  assert.equal(none.ready, false);
  assert.match(none.reason, /first read-pair/);
  // One pair only => still not ready (forced roll-and-average).
  const one = computeToeWizardResult(setup, [{ front: 0, rear: 1 }]);
  assert.equal(one.ready, false);
  assert.match(one.reason, /second read-pair/);
});

test('computeToeWizardResult averages the two read-pairs into total + per-wheel toe', () => {
  const setup = { method: 'plates', diameter: 28.648, specDiameter: 28.648, readUncertainty: 0.8 };
  // Two pairs that each give the "1 inch = ~2 deg" self-check total; average is the same.
  const res = computeToeWizardResult(setup, [{ front: 0, rear: 1 }, { front: 0, rear: 1 }]);
  assert.equal(res.ready, true);
  assert.equal(res.method, 'plates');
  assert.ok(Math.abs(res.totalToe - 1.999) < 1e-3);
  // Per-wheel is exactly half the total (symmetry assumption).
  assert.ok(Math.abs(res.perWheelToe - res.totalToe / 2) < 1e-12);
  // The average sits between two unequal read-pair angles.
  const mixed = computeToeWizardResult(setup, [{ front: 0, rear: 0 }, { front: 0, rear: 1 }]);
  const a0 = totalToeFromPlates(0, 0, 28.648);
  const a1 = totalToeFromPlates(1, 0, 28.648);
  assert.ok(Math.abs(mixed.totalToe - (a0 + a1) / 2) < 1e-12);
  // Toe-in (rear > front) is positive; toe-out negative.
  assert.ok(computeToeWizardResult(setup, [{ front: 0, rear: 1 }, { front: 0, rear: 1 }]).totalToe > 0);
  assert.ok(computeToeWizardResult(setup, [{ front: 1, rear: 0 }, { front: 1, rear: 0 }]).totalToe < 0);
});

test('computeToeWizardResult surfaces the band, linear equivalent, and runout disagreement', () => {
  const setup = { method: 'plates', diameter: 381, specDiameter: 381, readUncertainty: 0.8, runoutThreshold: 0.25 };
  // Agreeing pairs: band = differential u/D, linear = specDiameter * tan(total), runout within limit.
  const res = computeToeWizardResult(setup, [{ front: 0, rear: 1 }, { front: 0, rear: 1 }]);
  const expectedBand = toeReadUncertaintyDeg(0.8, 381, true);
  assert.ok(Math.abs(res.toleranceDeg - expectedBand) < 1e-12);
  assert.ok(Math.abs(res.totalLinear - toeAngleToLinear(res.totalToe, 381)) < 1e-12);
  assert.ok(Math.abs(res.perWheelLinear - toeAngleToLinear(res.perWheelToe, 381)) < 1e-12);
  assert.equal(res.runout.exceeds, false);
  // Disagreeing pairs trip the runout flag and the reason calls out re-seating.
  const faulty = computeToeWizardResult(setup, [{ front: 0, rear: 1 }, { front: 0, rear: 20 }]);
  assert.equal(faulty.runout.exceeds, true);
  assert.match(faulty.reason, /Runout/);
  // No spec diameter => no linear equivalent, but the angle still resolves.
  const noSpec = computeToeWizardResult({ method: 'tape', diameter: 381, readUncertainty: 0.8 }, [{ front: 0, rear: 1 }, { front: 0, rear: 1 }]);
  assert.equal(noSpec.ready, true);
  assert.equal(noSpec.method, 'tape');
  assert.equal(noSpec.totalLinear, null);
  assert.equal(noSpec.perWheelLinear, null);
});

test('computeToeStringBoxResult needs a positive diameter and all four corners', () => {
  const setup = { diameter: 28.648, specDiameter: 28.648, readUncertainty: 0.8 };
  const reads = {
    FL: { front: 1, rear: 0 },
    FR: { front: 1, rear: 0 },
    RL: { front: 1, rear: 0 },
    RR: { front: 1, rear: 0 },
  };
  // No diameter => not ready, with guidance.
  const noD = computeToeStringBoxResult({ ...setup, diameter: 0 }, reads);
  assert.equal(noD.ready, false);
  assert.match(noD.reason, /reference diameter/);
  // Missing a corner => not ready and the reason names it.
  const partial = computeToeStringBoxResult(setup, { FL: reads.FL, FR: reads.FR, RL: reads.RL });
  assert.equal(partial.ready, false);
  assert.match(partial.reason, /RR/);
  assert.equal(partial.perWheel.RR, null);
  // The band is still surfaced even before all corners are in.
  assert.ok(Math.abs(partial.toleranceDeg - toeReadUncertaintyDeg(0.8, 28.648, true)) < 1e-12);
});

test('computeToeStringBoxResult is toe-in positive when the front edge sits farther from the string', () => {
  const setup = { diameter: 28.648 };
  // frontGap (1) > rearGap (0): leading edge farther from the outboard string => nearer centerline
  // => toe-IN => positive, matching the "1 inch = ~2 deg" self-check.
  const res = computeToeStringBoxResult(setup, {
    FL: { front: 1, rear: 0 },
    FR: { front: 1, rear: 0 },
    RL: { front: 1, rear: 0 },
    RR: { front: 1, rear: 0 },
  });
  assert.equal(res.ready, true);
  assert.ok(res.perWheel.FL > 0);
  assert.ok(Math.abs(res.perWheel.FL - 1.999) < 1e-3);
  // rearGap > frontGap => toe-OUT => negative.
  const out = computeToeStringBoxResult(setup, {
    FL: { front: 0, rear: 1 },
    FR: { front: 0, rear: 1 },
    RL: { front: 0, rear: 1 },
    RR: { front: 0, rear: 1 },
  });
  assert.ok(out.perWheel.FL < 0);
});

test('computeToeStringBoxResult totals, thrust, and thrust-referenced front toe', () => {
  const setup = { diameter: 100, specDiameter: 100 };
  const res = computeToeStringBoxResult(setup, {
    FL: { front: 3, rear: 0 },
    FR: { front: 1, rear: 0 },
    RL: { front: 2, rear: 0 },
    RR: { front: 1, rear: 0 },
  });
  assert.equal(res.ready, true);
  // Totals are the sum of the per-wheel pair.
  assert.ok(Math.abs(res.totalFront - (res.perWheel.FL + res.perWheel.FR)) < 1e-12);
  assert.ok(Math.abs(res.totalRear - (res.perWheel.RL + res.perWheel.RR)) < 1e-12);
  // Thrust = (toeRL - toeRR) / 2, positive when RL toes in more than RR (thrust points left).
  assert.ok(Math.abs(res.thrust - (res.perWheel.RL - res.perWheel.RR) / 2) < 1e-12);
  assert.ok(res.thrust > 0);
  // Thrust-referencing preserves total front toe (FL - t) + (FR + t) = FL + FR.
  const refTotal = res.frontThrustReferenced.FL + res.frontThrustReferenced.FR;
  assert.ok(Math.abs(refTotal - res.totalFront) < 1e-12);
  assert.ok(Math.abs(res.frontThrustReferenced.FL - (res.perWheel.FL - res.thrust)) < 1e-12);
  // Linear equivalent travels per corner when a spec diameter is given.
  assert.ok(Math.abs(res.perWheelLinear.FL - toeAngleToLinear(res.perWheel.FL, 100)) < 1e-12);
});

test('computeToeStringBoxResult omits the linear equivalent without a spec diameter', () => {
  const res = computeToeStringBoxResult({ diameter: 100 }, {
    FL: { front: 1, rear: 0 },
    FR: { front: 1, rear: 0 },
    RL: { front: 1, rear: 0 },
    RR: { front: 1, rear: 0 },
  });
  assert.equal(res.ready, true);
  assert.equal(res.specDiameter, null);
  assert.equal(res.perWheelLinear.FL, null);
});

// --- CASTER: turning-angle / camber-swing math + uncertainty ------------------------------------

test('casterFromCamberSwing recovers caster from a known camber swing at 20 deg', () => {
  // Self-check: camberOut=+1.0, camberIn=-1.0, theta=20 => 2.0 / (2*sin20) = 2.0 / 0.6840 ~= 2.924.
  assert.ok(Math.abs(casterFromCamberSwing(1.0, -1.0, 20) - 2.924) < 1e-3);
  // The divisor is exactly 2*sin(20deg) ~= 0.6840: a 1.0 deg swing reads 1/0.6840 ~= 1.462.
  assert.ok(Math.abs(2 * Math.sin(20 * Math.PI / 180) - 0.6840) < 1e-4);
  assert.ok(Math.abs(casterFromCamberSwing(0.5, -0.5, 20) - (1.0 / 0.6840)) < 1e-3);
});

test('casterFromCamberSwing sign: out > in is positive, out < in is negative, equal is zero', () => {
  // camberOut > camberIn => positive caster.
  assert.ok(casterFromCamberSwing(1.0, -1.0, 20) > 0);
  assert.ok(casterFromCamberSwing(0.5, 0.2, 20) > 0);
  // camberOut < camberIn => negative caster.
  assert.ok(casterFromCamberSwing(-1.0, 1.0, 20) < 0);
  // No swing => exactly zero caster (the constant camber offset cancels).
  assert.equal(casterFromCamberSwing(0.3, 0.3, 20), 0);
});

test('casterFromCamberSwing self-calibrates: a constant camber offset cancels', () => {
  const theta = 18;
  const out = 0.8;
  const inn = -0.6;
  const offset = 1.37; // any constant zero-offset present in BOTH raw camber reads
  const clean = casterFromCamberSwing(out, inn, theta);
  const offsetted = casterFromCamberSwing(out + offset, inn + offset, theta);
  // The subtraction removes the offset, so caster is identical with or without zeroing.
  assert.ok(Math.abs(clean - offsetted) < 1e-12);
});

test('casterFromCamberSwing scales with 1/(2 sin theta)', () => {
  // A larger steer angle for the SAME camber swing yields a SMALLER caster (bigger divisor).
  const swingSmallTheta = casterFromCamberSwing(1.0, -1.0, 10);
  const swingBigTheta = casterFromCamberSwing(1.0, -1.0, 30);
  assert.ok(swingSmallTheta > swingBigTheta);
  // Matches the closed form exactly.
  assert.ok(Math.abs(casterFromCamberSwing(1.0, -1.0, 10) - (2.0 / (2 * Math.sin(10 * Math.PI / 180)))) < 1e-12);
});

test('casterFromCamberSwing null guards: non-finite inputs and non-positive / sin~0 steer angle', () => {
  assert.equal(casterFromCamberSwing(NaN, -1.0, 20), null);
  assert.equal(casterFromCamberSwing(1.0, NaN, 20), null);
  assert.equal(casterFromCamberSwing(1.0, -1.0, NaN), null);
  assert.equal(casterFromCamberSwing(1.0, -1.0, 0), null);
  assert.equal(casterFromCamberSwing(1.0, -1.0, -20), null);
  // theta = 180 deg => sin ~ 0 => guarded (would divide by ~0).
  assert.equal(casterFromCamberSwing(1.0, -1.0, 180), null);
});

test('casterBandDeg scales the camber read band by sqrt(2)/(2 sin theta) (~2x at 20 deg)', () => {
  const camberBand = 0.3;
  const readTerm = camberBand * Math.SQRT2 / (2 * Math.sin(20 * Math.PI / 180));
  // With no turn-angle uncertainty the band IS the read-noise term.
  assert.ok(Math.abs(casterBandDeg(camberBand, 20) - readTerm) < 1e-12);
  // The multiplier at 20deg is sqrt(2)/(2 sin20) ~= 1.414/0.684 ~= 2.067, i.e. ~2x the camber band.
  const ratio = casterBandDeg(camberBand, 20) / camberBand;
  assert.ok(Math.abs(ratio - 2.0671) < 1e-3);
  assert.ok(ratio > 2);
});

test('casterBandDeg folds in a turn-angle uncertainty term in quadrature', () => {
  const camberBand = 0.3;
  const noTurn = casterBandDeg(camberBand, 20, 0);
  const withTurn = casterBandDeg(camberBand, 20, 1);
  // A non-zero steer-angle uncertainty only ever GROWS the band (added in quadrature).
  assert.ok(withTurn > noTurn);
  // It matches the closed form: hypot(readTerm, readTerm * |cot(theta)| * d(theta_rad)).
  const theta = 20 * Math.PI / 180;
  const readTerm = camberBand * Math.SQRT2 / (2 * Math.sin(theta));
  const turnTerm = readTerm * Math.abs(Math.cos(theta) / Math.sin(theta)) * (1 * Math.PI / 180);
  assert.ok(Math.abs(withTurn - Math.hypot(readTerm, turnTerm)) < 1e-12);
  // A negative band / negative steer uncertainty is treated by magnitude (always non-negative band).
  assert.ok(casterBandDeg(-0.3, 20, -1) > 0);
});

test('casterBandDeg null guards: non-finite band / steer, non-positive and sin~0 steer angle', () => {
  assert.equal(casterBandDeg(NaN, 20), null);
  assert.equal(casterBandDeg(0.3, NaN), null);
  assert.equal(casterBandDeg(0.3, 0), null);
  assert.equal(casterBandDeg(0.3, -20), null);
  assert.equal(casterBandDeg(0.3, 180), null);
});
