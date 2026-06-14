// Pure logic for the precision workflow: baseline summary, per-side compensation,
// the precision summary, and the guided workflow step. Kept free of DOM, sensor,
// and storage code so the rules can be unit-tested in isolation.
import {
  average,
  captureSeriesStats,
  clamp,
  fitPlane,
  planeHeightForSide,
  CORNER_POSITIONS,
} from './domain.js';

export const SIDES = ['FL', 'FR', 'RL', 'RR'];

export const PRECISION_CONSTANTS = {
  // P1-5: readiness must match the displayed forward target (now 5, up from a mismatched
  // 2-vs-3), and a precision verdict requires a meaningful minimum of forward captures.
  MIN_PRECISION_CAPTURES_READY: 5,
  MIN_PRECISION_CAPTURES_VERDICT: 5,
  REPEATABILITY_RANGE_FACTOR: 120,
  REPEATABILITY_STDDEV_FACTOR: 220,
  REPEATABILITY_REVERSAL_FACTOR: 70,
  REVERSAL_REQUIRED_MISSING_PENALTY: 18,
  REVERSAL_OPTIONAL_MISSING_PENALTY: 8,
  FORWARD_CAPTURE_TARGET: 5,
  REVERSE_CAPTURE_TARGET: 2,
  INSUFFICIENT_CAPTURE_PENALTY: 10,
  ADJUSTMENT_QUALITY_THRESHOLD: 88,
  COMPARISON_QUALITY_THRESHOLD: 68,
  MAX_ACCEPTABLE_REVERSAL_BIAS: 0.08,
  BASELINE_QUALITY_PENALTIES: {
    Trusted: 0,
    Approximate: 8,
    Noisy: 18,
  },
  TRUSTED_STDDEV: 0.06,
  TRUSTED_RANGE: 0.16,
  APPROXIMATE_STDDEV: 0.14,
  APPROXIMATE_RANGE: 0.3,
  // P2-2: per-corner residual (deg) above which the four baseline points are treated as
  // non-coplanar, flagging a bad/mis-placed datum and downgrading the baseline to Noisy.
  PLANE_RESIDUAL_TOLERANCE: 0.08,
};

// P1-1: smallest offset difference that counts as a re-zero between forward and reverse sets.
// Captures taken with the same active zero will share an identical (already-rounded) offset, so
// anything past floating-point noise means the operator re-zeroed mid-flip and the (F-R)/2
// cancellation can no longer be trusted.
export const OFFSET_CONFLICT_TOLERANCE = 1e-6;

// P1-1: mean of the RAW (pre-calibration) capture values. Reversal cancellation must operate on
// readings BEFORE the per-mode zero so a re-zero between flips cannot leak half its error into
// (F_raw - R_raw)/2. Falls back to the display value for legacy snapshots saved before rawValue
// existed (those predate the reversal fix and simply behave as the old shared-offset path).
function rawSeriesMean(series = []) {
  if (!series.length) return null;
  const values = series.map(entry => (Number.isFinite(entry.rawValue) ? entry.rawValue : entry.value));
  return average(values);
}

// P1-1: the per-mode calibration offset that was active when these captures were taken. Returns
// null when a series mixes offsets (operator re-zeroed mid-set) or when no offset was recorded.
function seriesOffset(series = []) {
  const offsets = series
    .map(entry => (Number.isFinite(entry.offsetUsed) ? entry.offsetUsed : null))
    .filter(value => value !== null);
  if (!offsets.length) return null;
  const first = offsets[0];
  return offsets.every(value => Math.abs(value - first) <= OFFSET_CONFLICT_TOLERANCE) ? first : null;
}

// P2-1: the shared multiplicative scale gain across forward + reverse captures. calibrated =
// (raw - offset) * gain, and gain is a shared constant, so applying it AFTER the offset
// cancellation keeps the saved precision value consistent with the live calibrated reading.
// Defaults to 1 (no scale) for legacy snapshots and whenever captures mix gains.
function seriesGain(...series) {
  const gains = series
    .flat()
    .map(entry => (Number.isFinite(entry.gainUsed) && entry.gainUsed > 0 ? entry.gainUsed : null))
    .filter(value => value !== null);
  if (!gains.length) return 1;
  const first = gains[0];
  return gains.every(value => Math.abs(value - first) <= 1e-6) ? first : 1;
}

// P1-1: raw-based reversal cancellation. Both the corrected value and the bias are derived from
// the RAW capture means so the shared per-mode zero provably cancels: corrected = (F_raw-R_raw)/2,
// bias = (F_raw+R_raw)/2. `offsetConflict` is true when forward and reverse were captured with
// different per-mode zeros (a re-zero between flips), which invalidates the cancellation.
export function reversalFromCaptures(bucket = { forward: [], reverse: [] }) {
  const forward = Array.isArray(bucket.forward) ? bucket.forward : [];
  const reverse = Array.isArray(bucket.reverse) ? bucket.reverse : [];
  const forwardRawMean = rawSeriesMean(forward);
  const reverseRawMean = rawSeriesMean(reverse);
  const forwardOffset = seriesOffset(forward);
  const reverseOffset = seriesOffset(reverse);
  // P2-1: the shared scale gain (1 when no scale was set) is applied AFTER the offset cancellation
  // so the saved precision value matches the live calibrated (raw - offset) * gain reading.
  const gain = seriesGain(forward, reverse);
  // Display-only zeroed forward value (used when there is no reverse set to cancel against).
  const forwardZeroed = forwardRawMean === null
    ? null
    : (forwardRawMean - (forwardOffset || 0)) * gain;
  const hasBoth = forwardRawMean !== null && reverseRawMean !== null;
  const reversalBias = hasBoth ? ((forwardRawMean + reverseRawMean) / 2) * gain : null;
  const reversalCorrectedValue = hasBoth ? ((forwardRawMean - reverseRawMean) / 2) * gain : forwardZeroed;
  // A re-zero between forward and reverse leaks half the zero error into the difference; flag it.
  const offsetConflict = hasBoth
    && forwardOffset !== null
    && reverseOffset !== null
    && Math.abs(forwardOffset - reverseOffset) > OFFSET_CONFLICT_TOLERANCE;
  return {
    forwardRawMean,
    reverseRawMean,
    forwardZeroed,
    forwardOffset,
    reverseOffset,
    reversalBias,
    reversalCorrectedValue,
    offsetConflict,
  };
}

// P1-5: standard error of the mean for a capture series. sigma/sqrt(n), with the +/- 95%
// half-width (k ~= 2) the UI can surface next to a verdict. Returns null without enough data.
export function captureStandardError(stats, k = 2) {
  if (!stats || !Number.isFinite(stats.stdDev) || !Number.isFinite(stats.count) || stats.count < 2) return null;
  const standardError = stats.stdDev / Math.sqrt(stats.count);
  return { standardError, toleranceDeg: k * standardError, n: stats.count };
}

export function baselineSummary(baselinePoints = {}, sides = SIDES, constants = PRECISION_CONSTANTS) {
  const sideStats = sides.reduce((acc, side) => {
    const stats = captureSeriesStats(baselinePoints[side] || []);
    if (stats) acc[side] = stats;
    return acc;
  }, {});
  const completedSides = Object.keys(sideStats).length;
  const allMeans = Object.values(sideStats).map(item => item.mean);
  const overallMean = allMeans.length ? average(allMeans) : 0;
  const leftAvg = sideStats.FL && sideStats.RL ? average([sideStats.FL.mean, sideStats.RL.mean]) : null;
  const rightAvg = sideStats.FR && sideStats.RR ? average([sideStats.FR.mean, sideStats.RR.mean]) : null;
  const frontAvg = sideStats.FL && sideStats.FR ? average([sideStats.FL.mean, sideStats.FR.mean]) : null;
  const rearAvg = sideStats.RL && sideStats.RR ? average([sideStats.RL.mean, sideStats.RR.mean]) : null;
  const worstStdDev = Math.max(0, ...Object.values(sideStats).map(item => item.stdDev));
  const worstRange = Math.max(0, ...Object.values(sideStats).map(item => item.range));
  // P2-2: fit a least-squares plane z = a*x + b*y + c to whatever corner means we have (>= 3).
  // `a` is the left->right floor slope, `b` the rear->front slope, and the per-corner residuals
  // flag a non-coplanar / bad datum so a single mis-placed corner is visible rather than silently
  // averaged into the deltas. The plane drives the dimensionally-correct compensation below.
  const planePoints = Object.entries(sideStats).map(([side, stats]) => ({
    ...CORNER_POSITIONS[side],
    z: stats.mean,
    side,
  }));
  const plane = fitPlane(planePoints, { tolerance: constants.PLANE_RESIDUAL_TOLERANCE });
  let label = 'Incomplete';
  let tone = 'warn';

  if (completedSides === sides.length) {
    // P2-2: a plane that does not actually fit the four corners (a corner off the plane) is Noisy
    // regardless of per-corner repeatability, since the baseline plane is no longer trustworthy.
    if (plane && !plane.coplanar) {
      label = 'Noisy';
    } else if (worstStdDev <= constants.TRUSTED_STDDEV && worstRange <= constants.TRUSTED_RANGE) {
      label = 'Trusted';
      tone = 'good';
    } else if (worstStdDev <= constants.APPROXIMATE_STDDEV && worstRange <= constants.APPROXIMATE_RANGE) {
      label = 'Approximate';
    } else {
      label = 'Noisy';
    }
  }

  return {
    sideStats,
    completedSides,
    complete: completedSides === sides.length,
    overallMean,
    leftAvg,
    rightAvg,
    frontAvg,
    rearAvg,
    leftRightDelta: leftAvg !== null && rightAvg !== null ? leftAvg - rightAvg : null,
    frontRearDelta: frontAvg !== null && rearAvg !== null ? frontAvg - rearAvg : null,
    worstStdDev,
    worstRange,
    // P2-2: the fitted plane, its per-corner residuals, and whether the four points are coplanar.
    plane,
    planeResiduals: plane ? plane.residuals : {},
    planeMaxResidual: plane ? plane.maxResidual : null,
    planeCoplanar: plane ? plane.coplanar : null,
    label,
    tone,
  };
}

// P1-2 / P2-2: the baseline plane is fit (least squares) from LEVEL-mode floor readings (phone
// flat, world Z up). Compensation projects the relevant component of that plane onto the measured
// mode's axis, so the dimensionally-correct correction now comes from the plane SLOPES, not naive
// two-reading deltas:
//   - level  : subtract the plane height at this corner relative to the plane mean (a*x + b*y).
//   - pitch  : the front<->rear floor slope IS the pitch datum -> subtract the y-axis slope (b*y).
//   - camber : P2-2 enables the projection the stage-4 comment promised. Camber is read with the
//              phone upright measuring left<->right wheel-face tilt, which shares the level plane's
//              LEFT-RIGHT world axis. So the left-right floor slope at this corner (a*x) biases an
//              upright reading and is the correct camber compensation. Front<->rear floor slope is
//              orthogonal to the camber axis and is intentionally NOT subtracted.
//   - toe    : not derived from the floor plane -> excluded.
// Falls back to the pre-P2-2 deviations when no plane could be fit (e.g. fewer than 3 corners,
// reached only via direct calls — precisionSummary gates this on summary.complete anyway).
export function baselineCompensationForSide(side, mode, summary) {
  if (!summary || !summary.complete) return 0;
  const plane = summary.plane;
  const pos = CORNER_POSITIONS[side];
  if (mode === 'level') {
    if (plane && pos) return planeHeightForSide(side, plane) - plane.c;
    const stats = summary.sideStats[side];
    return stats ? stats.mean - summary.overallMean : 0;
  }
  if (mode === 'pitch') {
    // Front<->rear slope projected at this corner's y position.
    if (plane && pos) return plane.b * pos.y;
    const isFront = side === 'FL' || side === 'FR';
    const pairAvg = isFront ? summary.frontAvg : summary.rearAvg;
    return pairAvg !== null ? pairAvg - summary.overallMean : 0;
  }
  if (mode === 'camber') {
    // Left<->right slope projected at this corner's x position (same world axis as camber).
    if (plane && pos) return plane.a * pos.x;
    return 0;
  }
  return 0;
}

export function precisionSummary({ mode, side, captures = {}, baseline, fixture = null, constants = PRECISION_CONSTANTS }) {
  const key = `${mode}:${side}`;
  const bucket = captures[key] || { mode, side, forward: [], reverse: [] };
  const forward = captureSeriesStats(bucket.forward);
  const reverse = captureSeriesStats(bucket.reverse);
  const needsReverse = !!fixture?.reversible;
  const forwardReady = !!forward && forward.count >= constants.MIN_PRECISION_CAPTURES_READY;
  // Reverse sets are intentionally smaller (they only need to expose mounting bias), so they
  // are gated by their own target rather than the larger forward readiness floor.
  const reverseReady = !!reverse && reverse.count >= constants.REVERSE_CAPTURE_TARGET;
  // P1-5: a precision verdict needs a meaningful minimum so a couple of lucky captures
  // cannot earn an adjustment-grade trust signal.
  const enoughForVerdict = !!forward && forward.count >= constants.MIN_PRECISION_CAPTURES_VERDICT;
  // P1-5: trust the spread of the forward set via a proper standard error (sigma/sqrt(n)).
  const standardError = captureStandardError(forward);
  const captureCount = (forward?.count || 0) + (reverse?.count || 0);
  // P1-1: reversal cancellation runs on RAW (pre-calibration) capture means so a re-zero between
  // forward and reverse cannot leak half the zero error into (F_raw - R_raw)/2. Reversing the
  // fixture flips the true angle sign while leaving placement bias behind: averaging forward +
  // reverse exposes that bias, subtracting cancels the shared zero AND the bias back out.
  const reversal = reversalFromCaptures(bucket);
  const forwardOnlyValue = reversal.forwardZeroed;
  const reversalBias = reversal.reversalBias;
  const reversalCorrectedValue = reversal.reversalCorrectedValue;
  // P1-1: a re-zero between the forward and reverse sets invalidates the cancellation; "do not
  // re-zero between forward and reverse" is enforced by blocking the save below.
  const offsetConflict = reversal.offsetConflict;
  const baselineComp = Number.isFinite(reversalCorrectedValue) ? baselineCompensationForSide(side, mode, baseline) : 0;
  const finalValue = Number.isFinite(reversalCorrectedValue) ? reversalCorrectedValue - baselineComp : null;
  const rangePenalty = (forward?.range || 0) + (reverse?.range || 0);
  const deviationPenalty = (forward?.stdDev || 0) + (reverse?.stdDev || 0);
  const reversalPenalty = reversalBias === null
    ? (needsReverse ? constants.REVERSAL_REQUIRED_MISSING_PENALTY : constants.REVERSAL_OPTIONAL_MISSING_PENALTY)
    : Math.abs(reversalBias) * constants.REPEATABILITY_REVERSAL_FACTOR;
  const baselinePenalty = !baseline?.complete
    ? constants.BASELINE_QUALITY_PENALTIES.Noisy
    : (constants.BASELINE_QUALITY_PENALTIES[baseline.label] ?? constants.BASELINE_QUALITY_PENALTIES.Noisy);
  const capturePenalty = Math.max(0, constants.FORWARD_CAPTURE_TARGET - (forward?.count || 0)) * constants.INSUFFICIENT_CAPTURE_PENALTY
    + (needsReverse ? Math.max(0, constants.REVERSE_CAPTURE_TARGET - (reverse?.count || 0)) * constants.INSUFFICIENT_CAPTURE_PENALTY : 0);
  const repeatabilityScore = clamp(
    Math.round(100 - (rangePenalty * constants.REPEATABILITY_RANGE_FACTOR) - (deviationPenalty * constants.REPEATABILITY_STDDEV_FACTOR) - reversalPenalty - baselinePenalty - capturePenalty),
    5,
    99,
  );

  let verdict = 'Need more captures';
  // P1-1: a re-zero between forward and reverse breaks the reversal cancellation, so the set
  // cannot be trusted regardless of repeatability — surface it as its own verdict and block save.
  if (offsetConflict) {
    verdict = 'Re-zeroed between flips';
  } else if (forwardReady && enoughForVerdict && (!needsReverse || reverseReady)) {
    if (repeatabilityScore >= constants.ADJUSTMENT_QUALITY_THRESHOLD
        && baseline?.label === 'Trusted'
        && (!needsReverse || Math.abs(reversalBias || 0) <= constants.MAX_ACCEPTABLE_REVERSAL_BIAS)) {
      // P0-3 honesty: repeatability is NOT trueness. A tight, reversible-bias-cancelled set proves
      // the reading is REPEATABLE, but only a comparison against a known reference (or a passed
      // flip self-test) proves it is TRUE — so the top verdict no longer claims "adjustment grade".
      verdict = 'Repeatable — verify vs a known reference';
    } else if (repeatabilityScore >= constants.COMPARISON_QUALITY_THRESHOLD) {
      verdict = 'Good enough for comparison';
    } else {
      verdict = 'Re-run session';
    }
  }

  return {
    bucket,
    forward,
    reverse,
    forwardOnlyValue,
    reversalCorrectedValue,
    finalValue,
    reversalBias,
    offsetConflict,
    baselineCompensation: baselineComp,
    baseline,
    needsReverse,
    readyToSave: forwardReady && enoughForVerdict && (!needsReverse || reverseReady) && !offsetConflict,
    repeatabilityScore,
    standardError: standardError ? standardError.standardError : null,
    toleranceDeg: standardError ? standardError.toleranceDeg : null,
    captureCount,
    n: forward?.count || 0,
    verdict,
  };
}

// Pure decision table for the guided workflow card. Returns the title, description,
// warning, and tone the UI should render without touching the DOM. Splitting this
// out of refreshGuide() makes the 13-branch logic individually testable.
export function computeGuideState({
  sensorsAvailable,
  notice,
  workflow,
  mode,
  selectedSide,
  deviceProfileSet,
  fixtureSelected,
  calibrationSet,
  levelPrepared,
  // P0-4: orientationOk now means PHYSICAL pose is right for the mode (gravity-derived). It is
  // a non-blocking hint: a mismatch appends a pose warning to the live steps but never preempts
  // the settle/save flow, since the settle gate no longer depends on it.
  orientationOk,
  poseFamilyLabel,
  settled,
  baseline,
  precision,
  modeLabel,
  guide,
  telemetryActive = true,
}) {
  // P0-4: pose hint text appended (non-blocking) to the live settle/save steps when the phone
  // is not in the mode's pose family. It downgrades a 'good' step to a 'warn' tone but never
  // hides the action, so a settled reading can still be saved out of the ideal pose.
  const poseHint = orientationOk
    ? null
    : `Phone is not in the ${poseFamilyLabel || guide.orientation} pose for ${modeLabel} — placement may be less repeatable.`;
  const withPoseHint = step => poseHint
    ? { ...step, warning: `${step.warning} ${poseHint}`, tone: step.tone === 'good' ? 'warn' : step.tone }
    : step;
  if (!sensorsAvailable) {
    return {
      title: '1. Verify level surface',
      description: 'Use Level mode before alignment readings so your baseline is trustworthy.',
      warning: 'Enable motion access in Safari to begin measuring.',
      tone: 'warn',
    };
  }
  if (notice) {
    return {
      title: '1. Verify level surface',
      description: 'Use Level mode before alignment readings so your baseline is trustworthy.',
      warning: notice.text,
      tone: notice.tone,
    };
  }
  if (!telemetryActive) {
    return {
      title: mode === 'level' ? '1. Start Level measurement' : `Start ${modeLabel}`,
      description: mode === 'level'
        ? 'Begin with Level so the workflow can verify the surface and build a trustworthy baseline.'
        : `Start Measuring only when the phone is placed for ${modeLabel}. The app will collect quality data, then pause after save.`,
      warning: 'Sensor telemetry is paused until you start the next measurement step.',
      tone: 'warn',
    };
  }
  if (workflow === 'precision' && !deviceProfileSet) {
    return {
      title: '1. Capture device reference',
      description: 'Place the phone on a trusted reference and capture device bias before trusting a precision session.',
      warning: 'Device reference is not set yet.',
      tone: 'warn',
    };
  }
  if (workflow === 'precision' && !fixtureSelected) {
    return {
      title: '2. Confirm the fixture',
      description: 'Use a named fixture profile so the same jig, phone registration, and wheel datum are reused across the session.',
      warning: 'Select or save a fixture profile before wheel captures.',
      tone: 'warn',
    };
  }
  if (workflow === 'precision' && mode !== 'level' && !baseline.complete) {
    return {
      title: '3. Establish the baseline plane',
      description: 'Switch to Level mode and capture FL, FR, RL, and RR points before precision wheel measurements.',
      warning: `${baseline.completedSides}/4 baseline points are ready.`,
      tone: 'warn',
    };
  }
  if (!levelPrepared && mode !== 'level') {
    return {
      title: '1. Verify level surface',
      description: 'Use Level mode before alignment readings so your baseline is trustworthy.',
      warning: 'Switch to Level mode and confirm the floor or car is level before alignment readings.',
      tone: 'warn',
    };
  }
  if (!calibrationSet) {
    return {
      title: '2. Set a zero reference',
      description: guide.calibration,
      warning: 'This mode is not zeroed yet. Zero it on a known reference for better repeatability.',
      tone: 'warn',
    };
  }
  // P0-4: NO blocking orientation step here. A pose mismatch is folded into the live steps
  // below via withPoseHint(), so it warns without hiding the capture/settle/save actions.
  if (workflow === 'precision' && !(precision.forward && precision.forward.count)) {
    return withPoseHint({
      title: '4. Capture forward readings',
      description: `Take repeated settled ${mode} readings for ${selectedSide} with the fixture in its normal orientation.`,
      warning: 'Forward precision capture set is empty.',
      tone: 'warn',
    });
  }
  if (workflow === 'precision' && precision.needsReverse && !(precision.reverse && precision.reverse.count)) {
    return withPoseHint({
      title: '5. Capture reversed readings',
      description: 'Flip the jig or phone in the reversible direction, then capture the same point again to estimate fixture bias.',
      warning: 'Reversed precision capture set is still missing.',
      tone: 'warn',
    });
  }
  if (!settled) {
    return withPoseHint({
      title: '4. Hold steady',
      description: 'The app is averaging recent samples. Keep the phone planted and avoid hand movement until stability turns to Settled.',
      warning: 'Movement or jitter is still above the settled threshold.',
      tone: 'warn',
    });
  }
  if (workflow === 'precision') {
    return withPoseHint({
      title: '6. Save the precision report',
      description: `Review repeatability, reversal bias, and baseline trust before saving ${mode} for ${selectedSide}.`,
      warning: `${precision.verdict} • Repeatability ${precision.repeatabilityScore}%`,
      tone: precision.verdict === 'Repeatable — verify vs a known reference' ? 'good' : 'warn',
    });
  }
  return withPoseHint({
    title: '5. Save the averaged reading',
    description: `Reading is settled. Lock it if needed, then save the averaged ${mode} value for ${selectedSide}.`,
    warning: 'Consumer-grade sensors are best for repeatable DIY checks, not certified rack alignment.',
    tone: 'good',
  });
}
