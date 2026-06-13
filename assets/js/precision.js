// Pure logic for the precision workflow: baseline summary, per-side compensation,
// the precision summary, and the guided workflow step. Kept free of DOM, sensor,
// and storage code so the rules can be unit-tested in isolation.
import { average, captureSeriesStats, clamp } from './domain.js';

export const SIDES = ['FL', 'FR', 'RL', 'RR'];

export const PRECISION_CONSTANTS = {
  MIN_PRECISION_CAPTURES_READY: 2,
  REPEATABILITY_RANGE_FACTOR: 120,
  REPEATABILITY_STDDEV_FACTOR: 220,
  REPEATABILITY_REVERSAL_FACTOR: 70,
  REVERSAL_REQUIRED_MISSING_PENALTY: 18,
  REVERSAL_OPTIONAL_MISSING_PENALTY: 8,
  FORWARD_CAPTURE_TARGET: 3,
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
};

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
  let label = 'Incomplete';
  let tone = 'warn';

  if (completedSides === sides.length) {
    if (worstStdDev <= constants.TRUSTED_STDDEV && worstRange <= constants.TRUSTED_RANGE) {
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
    label,
    tone,
  };
}

export function baselineCompensationForSide(side, mode, summary) {
  if (!summary || !summary.complete) return 0;
  if (mode === 'camber' || mode === 'level') {
    const stats = summary.sideStats[side];
    return stats ? stats.mean - summary.overallMean : 0;
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
  const reverseReady = !!reverse && reverse.count >= constants.MIN_PRECISION_CAPTURES_READY;
  const forwardOnlyValue = forward ? forward.mean : null;
  // Reversing the fixture should flip the true angle sign while leaving placement bias behind.
  // Averaging forward + reverse exposes that bias, while subtracting reverse from forward cancels the shared bias back out.
  const reversalBias = forward && reverse ? (forward.mean + reverse.mean) / 2 : null;
  const reversalCorrectedValue = forward && reverse ? (forward.mean - reverse.mean) / 2 : forwardOnlyValue;
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
  if (forwardReady && (!needsReverse || reverseReady)) {
    if (repeatabilityScore >= constants.ADJUSTMENT_QUALITY_THRESHOLD
        && baseline?.label === 'Trusted'
        && (!needsReverse || Math.abs(reversalBias || 0) <= constants.MAX_ACCEPTABLE_REVERSAL_BIAS)) {
      verdict = 'Good enough for adjustment';
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
    baselineCompensation: baselineComp,
    baseline,
    needsReverse,
    readyToSave: forwardReady && (!needsReverse || reverseReady),
    repeatabilityScore,
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
  orientationOk,
  screenOrientationLabel,
  preferredOrientationLabel,
  settled,
  baseline,
  precision,
  modeLabel,
  guide,
  telemetryActive = true,
}) {
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
  if (!orientationOk) {
    return {
      title: `3. Rotate to ${guide.orientation}`,
      description: `For ${modeLabel}, ${guide.orientation.toLowerCase()} orientation gives a more repeatable placement.`,
      warning: `Current orientation is ${screenOrientationLabel}. Rotate to ${preferredOrientationLabel}.`,
      tone: 'warn',
    };
  }
  if (workflow === 'precision' && !(precision.forward && precision.forward.count)) {
    return {
      title: '4. Capture forward readings',
      description: `Take repeated settled ${mode} readings for ${selectedSide} with the fixture in its normal orientation.`,
      warning: 'Forward precision capture set is empty.',
      tone: 'warn',
    };
  }
  if (workflow === 'precision' && precision.needsReverse && !(precision.reverse && precision.reverse.count)) {
    return {
      title: '5. Capture reversed readings',
      description: 'Flip the jig or phone in the reversible direction, then capture the same point again to estimate fixture bias.',
      warning: 'Reversed precision capture set is still missing.',
      tone: 'warn',
    };
  }
  if (!settled) {
    return {
      title: '4. Hold steady',
      description: 'The app is averaging recent samples. Keep the phone planted and avoid hand movement until stability turns to Settled.',
      warning: 'Movement or jitter is still above the settled threshold.',
      tone: 'warn',
    };
  }
  if (workflow === 'precision') {
    return {
      title: '6. Save the precision report',
      description: `Review repeatability, reversal bias, and baseline trust before saving ${mode} for ${selectedSide}.`,
      warning: `${precision.verdict} • Repeatability ${precision.repeatabilityScore}%`,
      tone: precision.verdict === 'Good enough for adjustment' ? 'good' : 'warn',
    };
  }
  return {
    title: '5. Save the averaged reading',
    description: `Reading is settled. Lock it if needed, then save the averaged ${mode} value for ${selectedSide}.`,
    warning: 'Consumer-grade sensors are best for repeatable DIY checks, not certified rack alignment.',
    tone: 'good',
  };
}
