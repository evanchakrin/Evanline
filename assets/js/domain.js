export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function degToRad(value) {
  return value * Math.PI / 180;
}

// Reconstruct the gravity direction in the device frame from W3C DeviceOrientation
// Euler angles (intrinsic Z-X'-Y''). FALLBACK source only: near beta ~= ±90 the
// camber signal lives in components scaled by cos(beta) ~= 0, so this is adequate
// for level/pitch but weak for camber. Prefer raw accelerometer gravity when available.
export function gravityFromEuler({ beta, gamma } = {}) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b = degToRad(beta);
  const g = degToRad(gamma);
  return {
    x: -Math.cos(b) * Math.sin(g),
    y: Math.sin(b),
    z: -Math.cos(b) * Math.cos(g),
  };
}

function finiteGravity(g) {
  return g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z);
}

// Camber: phone held upright (portrait) flush against a vertical wheel face. At that real pose
// gravity points toward the phone's BOTTOM (device -y), so we center on -g.y: atan2(g.x, -g.y)
// reads 0 when plumb and ±tilt as the top leans left/right. The old atan2(g.x, g.y) sat on the
// atan2 branch cut (~±180°) for this pose, so sensor noise straddled +180/-180, the windowed
// range exploded to ~360°, and camber could NEVER settle. The primary devicemotion accelerometer
// path is the trustworthy source here; the Euler fallback's camber is weak near vertical
// (gravityFromEuler loses the signal as cos(beta)->0). VERIFY sign on-device via sensor-check.html.
export function camberDeg(g) {
  if (!finiteGravity(g)) return null;
  return Math.atan2(g.x, -g.y) * 180 / Math.PI;
}

// Level: phone flat in landscape, left/right tilt across the device width.
export function levelDeg(g) {
  if (!finiteGravity(g)) return null;
  return Math.atan2(g.x, Math.hypot(g.y, g.z)) * 180 / Math.PI;
}

// Pitch: phone flat in landscape, front/back tilt along the device length.
export function pitchDeg(g) {
  if (!finiteGravity(g)) return null;
  return Math.atan2(g.y, Math.hypot(g.x, g.z)) * 180 / Math.PI;
}

// Map a measurement mode onto its gravity-vector inclination. Toe is handled in a
// later stage so it returns null here. Returns null when gravity is missing/non-finite.
export function inclinationForMode(mode, g) {
  if (!finiteGravity(g)) return null;
  if (mode === 'level') return levelDeg(g);
  if (mode === 'pitch') return pitchDeg(g);
  if (mode === 'toe') return null;
  return camberDeg(g);
}

// P0-4: physical-pose family for a mode, derived from where gravity is expected to point
// in the device frame (NOT the screen aspect ratio). Camber/toe are read with the phone
// upright (gravity along ±y); level/pitch are read with the phone flat (gravity along ±z).
export function poseFamilyForMode(mode) {
  return (mode === 'camber' || mode === 'toe') ? 'upright' : 'flat';
}

// P0-4: is the phone in the right PHYSICAL pose for this mode? Replaces the old aspect-ratio
// orientation gate. Compares the gravity direction against the family's reference axis:
// 'upright' expects gravity dominated by ±y, 'flat' expects ±z. The tolerance is generous
// (default 45°) so a phone tilted by a normal measurement angle still counts as in-pose; it
// only fails when the phone is in the wrong family entirely (e.g. flat while in camber mode).
// Returns true when gravity is missing/zero so it never blocks the pure-Euler fallback, and
// this result is advisory only (a hint/confidence penalty), never a hard settle gate.
export function poseOkForMode(mode, g, toleranceDeg = 45) {
  if (!finiteGravity(g)) return true;
  const magnitude = Math.hypot(g.x, g.y, g.z);
  if (!(magnitude > 0)) return true;
  const referenceComponent = poseFamilyForMode(mode) === 'upright' ? g.y : g.z;
  const tiltFromReference = Math.acos(clamp(Math.abs(referenceComponent) / magnitude, 0, 1)) * 180 / Math.PI;
  return tiltFromReference <= toleranceDeg;
}

// P1-3a: the screen-orientation family a mode's zero must be captured in. Camber/toe are
// portrait-family (phone upright), level/pitch landscape-family (phone flat). Mirrors the
// pose family but in the screen-orientation vocabulary stored on calibrationMeta.
export function preferredOrientationForMode(mode) {
  return poseFamilyForMode(mode) === 'upright' ? 'portrait' : 'landscape';
}

// P0-4 / P1-3a: derive the orientation family from the PHYSICAL pose (gravity), not the screen
// aspect ratio. Upright phones (gravity along ±y) read as 'portrait', flat phones (gravity
// along ±z) as 'landscape'. Returns null when gravity is missing so callers can fall back to a
// screen hint. The y-vs-z dominance split is the physical equivalent of the family check.
export function poseOrientation(g) {
  if (!finiteGravity(g)) return null;
  return Math.abs(g.y) >= Math.abs(g.z) ? 'portrait' : 'landscape';
}

// P1-3a: a stored per-mode zero is only valid if it was captured in the mode's preferred
// orientation family. A zero captured in the wrong family (e.g. camber zeroed in landscape)
// is discarded so we never silently apply an offset taken in an incompatible pose. Returns
// false when no calibration is stored. Pass currentOrientation to ALSO require the live
// orientation to match the mode's family (the phone is physically posed for this mode now).
export function calibrationZeroValid(mode, calibrationMeta, currentOrientation = null) {
  if (!calibrationMeta || !Number.isFinite(calibrationMeta.offset)) return false;
  const expected = preferredOrientationForMode(mode);
  if (calibrationMeta.orientation !== expected) return false;
  if (currentOrientation !== null && currentOrientation !== expected) return false;
  return true;
}

// P2-1: two-point SCALE calibration. A per-mode zero corrects an additive offset, but a sensor
// can also under/over-report by a multiplicative factor (e.g. reads 9.0° on a true 10.0° wedge).
// After zeroing, hold the phone on a KNOWN reference angle and capture its measured (post-zero)
// value; gain = trueAngle / measuredAngle is the linear scale that maps measured onto true.
// Returns null (no scale) when either input is non-finite, the measured value is ~0 (division
// would blow up / be meaningless near zero), or the resulting gain is implausible — so a bad
// capture degrades gracefully to the default unity gain rather than corrupting every reading.
export function scaleGainFromReference(trueAngle, measuredAngle, { minMeasured = 0.5, maxGain = 5 } = {}) {
  if (!Number.isFinite(trueAngle) || !Number.isFinite(measuredAngle)) return null;
  if (Math.abs(measuredAngle) < minMeasured) return null;
  const gain = trueAngle / measuredAngle;
  if (!Number.isFinite(gain) || gain <= 0 || gain > maxGain || gain < 1 / maxGain) return null;
  return gain;
}

// P2-1: apply the full per-mode calibration: subtract the additive zero, then multiply by the
// stored gain. calibrated = (raw - offset) * gain. Gain defaults to 1 (no-op) when not set, so
// modes without a scale capture behave exactly as before. Returns null when raw is null (no
// gravity-derived reading) so the "no reading" pipeline is preserved.
export function applyScaleCalibration(rawAngle, offset = 0, gain = 1) {
  if (!Number.isFinite(rawAngle)) return null;
  const offsetValue = Number.isFinite(offset) ? offset : 0;
  const gainValue = Number.isFinite(gain) && gain > 0 ? gain : 1;
  return (rawAngle - offsetValue) * gainValue;
}

// P2-5: pure normalization of one persisted capture snapshot. Extracted from loadState so the
// tolerant-coercion rules (legacy data missing rawValue/offsetUsed/gainUsed/context stamps stays
// loadable and behaves as the older shared-offset, unity-gain path) are unit-testable in
// isolation. `nowIso` is injected so the default-time fallback is deterministic.
export function normalizeCaptureSnapshot(entry = {}, nowIso = new Date().toISOString()) {
  return {
    value: Number(entry.value),
    // P1-1: null rawValue makes reversalFromCaptures fall back to the display value (legacy path).
    rawValue: Number.isFinite(entry.rawValue) ? Number(entry.rawValue) : null,
    offsetUsed: Number.isFinite(entry.offsetUsed) ? Number(entry.offsetUsed) : null,
    // P2-1: legacy captures had no gain -> treat as unity.
    gainUsed: Number.isFinite(entry.gainUsed) && entry.gainUsed > 0 ? Number(entry.gainUsed) : 1,
    confidence: Number.isFinite(entry.confidence) ? entry.confidence : 0,
    samples: Number.isFinite(entry.samples) ? entry.samples : 0,
    range: Number.isFinite(entry.range) ? entry.range : 0,
    stdDev: Number.isFinite(entry.stdDev) ? entry.stdDev : 0,
    // P1-4 / P2-3: optional +/- band stamp.
    toleranceDeg: Number.isFinite(entry.toleranceDeg) ? Number(entry.toleranceDeg) : null,
    orientation: entry.orientation === 'landscape' ? 'landscape' : 'portrait',
    // P2-3: physical/calibration context stamps. Absent on legacy data -> null/'' so a delta across
    // mismatched contexts can be detected without breaking old sessions.
    pose: entry.pose === 'landscape' || entry.pose === 'portrait' ? entry.pose : null,
    deviceRefTime: typeof entry.deviceRefTime === 'string' ? entry.deviceRefTime : null,
    fixtureId: typeof entry.fixtureId === 'string' ? entry.fixtureId : '',
    time: typeof entry.time === 'string' ? entry.time : nowIso,
  };
}

// P2-5: pure normalization of one persisted baseline point (no reversal context, so it carries
// only the display value and quality fields). Kept separate from capture snapshots because
// baselines never go through reversal.
export function normalizeBaselinePoint(item = {}, nowIso = new Date().toISOString()) {
  return {
    value: Number(item.value),
    confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
    samples: Number.isFinite(item.samples) ? item.samples : 0,
    range: Number.isFinite(item.range) ? item.range : 0,
    stdDev: Number.isFinite(item.stdDev) ? item.stdDev : 0,
    orientation: item.orientation === 'landscape' ? 'landscape' : 'portrait',
    time: typeof item.time === 'string' ? item.time : nowIso,
  };
}

// P2-5: pure normalization/migration of one persisted per-mode calibration entry. Returns null
// for an entry with no finite offset (treated as "not zeroed"), and tolerantly carries the
// optional P2-1 scale gain forward when present. This is the v2->v3 forward-compatible shape: old
// data that only had {offset, time, orientation} loads unchanged with unity gain.
export function normalizeCalibrationMeta(item) {
  if (!item || !Number.isFinite(item.offset) || typeof item.time !== 'string') return null;
  const meta = {
    offset: item.offset,
    time: item.time,
    orientation: item.orientation === 'landscape' ? 'landscape' : 'portrait',
  };
  if (Number.isFinite(item.gain) && item.gain > 0) {
    meta.gain = Number(item.gain);
    if (Number.isFinite(item.gainReference)) meta.gainReference = Number(item.gainReference);
    if (typeof item.gainTime === 'string') meta.gainTime = item.gainTime;
  }
  return meta;
}

// P2-5: pure normalization of one persisted saved measurement, including the P2-3 context stamps
// and the bounded save history. Extracted from loadState so the tolerant coercion is testable and
// so old data (no stamps, no history) loads unchanged. `nowIso` is injected for determinism.
// `maxHistory` bounds how many prior values are retained per mode+side.
export function normalizeMeasurement(item = {}, nowIso = new Date().toISOString(), maxHistory = 4) {
  const history = Array.isArray(item.history)
    ? item.history
        .filter(entry => entry && Number.isFinite(entry.value))
        .slice(-maxHistory)
        .map(entry => ({
          value: Number(entry.value),
          time: typeof entry.time === 'string' ? entry.time : nowIso,
          confidence: Number.isFinite(entry.confidence) ? entry.confidence : 0,
          toleranceDeg: Number.isFinite(entry.toleranceDeg) ? Number(entry.toleranceDeg) : null,
          workflow: entry.workflow === 'precision' ? 'precision' : 'quick',
        }))
    : [];
  return {
    id: `${item.mode}-${item.side}`,
    mode: item.mode,
    side: item.side,
    value: Number(item.value),
    confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
    // P1-4: tolerate older readings saved before the +/- band existed.
    toleranceDeg: Number.isFinite(item.toleranceDeg) ? Number(item.toleranceDeg) : null,
    samples: Number.isFinite(item.samples) ? item.samples : 0,
    time: typeof item.time === 'string' ? item.time : nowIso,
    workflow: item.workflow === 'precision' ? 'precision' : 'quick',
    rawValue: Number.isFinite(item.rawValue) ? Number(item.rawValue) : null,
    correctedValue: Number.isFinite(item.correctedValue) ? Number(item.correctedValue) : null,
    reversalBias: Number.isFinite(item.reversalBias) ? Number(item.reversalBias) : null,
    repeatabilityScore: Number.isFinite(item.repeatabilityScore) ? item.repeatabilityScore : null,
    captureCount: Number.isFinite(item.captureCount) ? item.captureCount : null,
    baselineQuality: typeof item.baselineQuality === 'string' ? item.baselineQuality : null,
    trustVerdict: typeof item.trustVerdict === 'string' ? item.trustVerdict : null,
    fixtureId: typeof item.fixtureId === 'string' ? item.fixtureId : '',
    // P2-3: calibration/orientation context stamps for the delta-mismatch guard. Absent on legacy
    // data -> null/'' so old readings still load and compare as "unknown context" (non-blocking).
    offsetUsed: Number.isFinite(item.offsetUsed) ? Number(item.offsetUsed) : null,
    gainUsed: Number.isFinite(item.gainUsed) && item.gainUsed > 0 ? Number(item.gainUsed) : null,
    orientation: item.orientation === 'landscape' || item.orientation === 'portrait' ? item.orientation : null,
    pose: item.pose === 'landscape' || item.pose === 'portrait' ? item.pose : null,
    deviceRefTime: typeof item.deviceRefTime === 'string' ? item.deviceRefTime : null,
    history,
  };
}

// P2-3: should a left-right / front-rear delta be trusted across two saved readings? A delta is
// only meaningful when both readings were captured under the SAME calibration/orientation context:
// the same active offset, the same gain, the same pose/orientation, the same device reference, and
// the same fixture. Mismatched context means the two numbers are not directly comparable, so the
// UI should warn rather than silently subtract. Returns { ok, reasons[] }. Missing (null/undefined)
// stamps on one side are treated as "unknown" and do NOT by themselves trip a mismatch (legacy
// readings) — only two present-but-different values do.
export function deltaContextMatch(a, b) {
  if (!a || !b) return { ok: true, reasons: [] };
  const reasons = [];
  const bothFinite = (x, y) => Number.isFinite(x) && Number.isFinite(y);
  const bothString = (x, y) => typeof x === 'string' && typeof y === 'string';
  if (bothFinite(a.offsetUsed, b.offsetUsed) && Math.abs(a.offsetUsed - b.offsetUsed) > 1e-3) reasons.push('zero offset');
  if (bothFinite(a.gainUsed, b.gainUsed) && Math.abs(a.gainUsed - b.gainUsed) > 1e-3) reasons.push('scale gain');
  const poseA = a.pose || a.orientation;
  const poseB = b.pose || b.orientation;
  if (bothString(poseA, poseB) && poseA !== poseB) reasons.push('orientation/pose');
  if (bothString(a.deviceRefTime, b.deviceRefTime) && a.deviceRefTime !== b.deviceRefTime) reasons.push('device reference');
  if (bothString(a.fixtureId, b.fixtureId) && a.fixtureId && b.fixtureId && a.fixtureId !== b.fixtureId) reasons.push('fixture');
  return { ok: reasons.length === 0, reasons };
}

export function clampAngle(value, range) {
  return clamp(value, -range, range);
}

export function polarPoint(cx, cy, r, angleDeg) {
  const rad = degToRad(angleDeg - 90);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function buildArcPath(cx, cy, r, startDeg, endDeg) {
  const start = polarPoint(cx, cy, r, startDeg);
  const end = polarPoint(cx, cy, r, endDeg);
  const largeArcFlag = (endDeg - startDeg) >= 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

export function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function standardDeviation(values = []) {
  if (!values.length) return 0;
  const avg = average(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

export function captureSeriesStats(series = []) {
  if (!series.length) return null;
  const values = series.map(item => item.value);
  return {
    count: series.length,
    mean: average(values),
    range: Math.max(...values) - Math.min(...values),
    stdDev: standardDeviation(values),
    latest: series[series.length - 1],
  };
}

// Drift magnitude: |mean(second half) - mean(first half)| of a sample buffer. A slow
// ramp can have a small instantaneous range/stdDev yet still be trending, which this
// catches. Buffers with fewer than two samples per half report 0 (no trend to measure).
export function bufferDrift(sampleBuffer = []) {
  const n = sampleBuffer.length;
  if (n < 4) return 0;
  const half = Math.floor(n / 2);
  const firstHalf = sampleBuffer.slice(0, half);
  const secondHalf = sampleBuffer.slice(n - half);
  return Math.abs(average(secondHalf) - average(firstHalf));
}

// 95% half-width of the mean (the +/- band reported in degrees). k*sigma/sqrt(N_eff),
// k ~= 2 for a ~95% interval. N_eff accounts for autocorrelation: with a raw (un-EMA'd)
// buffer rho ~= 0 so N_eff ~= N; pass a smoothingAlpha to discount an EMA-smoothed input.
// Returns null when there is too little data to estimate a band.
export function toleranceHalfWidth({ stdDev, sampleCount, k = 2, smoothingAlpha = 0 } = {}) {
  if (!Number.isFinite(stdDev) || !Number.isFinite(sampleCount) || sampleCount < 2) return null;
  const rho = smoothingAlpha > 0 ? (1 - smoothingAlpha) : 0;
  const nEff = rho > 0 ? sampleCount * (1 - rho) / (1 + rho) : sampleCount;
  const effective = Math.max(1, nEff);
  return k * stdDev / Math.sqrt(effective);
}

export function computeSampleQuality({
  sampleBuffer = [],
  // P0-4: now a physical-pose hint (is the phone in the right pose family for the mode?).
  // It only drives the confidence penalty and an advisory warning — never the settle gate.
  orientationOk,
  calibrationSet,
  now,
  settledStart,
  alignedStart,
  alignedThreshold,
  minSampleCount,
  settledRange,
  settledStdDev,
  settledHoldMs,
  alignedHoldMs,
  maxConfidenceBase,
  rangePenalty,
  stdDevPenalty,
  orientationPenalty,
  calibrationPenalty,
  // P0-3: trend test. Even a tight range/stdDev can hide a slow ramp; require the
  // half-to-half drift to stay under driftTol before settling.
  driftTol = 0.03,
  // P0-5: a non-finite chosen axis / implausible gravity means there is no real reading.
  // When false, settle/save are blocked and an explicit message is surfaced.
  readingOk = true,
  // P0-6: quasi-static motion gate. When false (|g| outside band or high rotation),
  // dispersion may look stable but we must reject the capture.
  motionOk = true,
  // P1-6: stream health. When false (no fresh sensor event in the staleness window),
  // any settle is voided.
  streamOk = true,
  // P1-4: discount N for autocorrelation if the buffer is EMA-smoothed (raw buffer => 0).
  smoothingAlpha = 0,
}) {
  const range = sampleBuffer.length ? Math.max(...sampleBuffer) - Math.min(...sampleBuffer) : 0;
  const stdDev = standardDeviation(sampleBuffer);
  const avg = sampleBuffer.length ? average(sampleBuffer) : 0;
  const drift = bufferDrift(sampleBuffer);
  const enoughSamples = sampleBuffer.length >= minSampleCount;
  const dispersionOk = range <= settledRange && stdDev <= settledStdDev && drift <= driftTol;
  // P0-4: orientationOk is now a physical-pose hint, NOT a hard gate. A pose mismatch only
  // costs confidence (below) and surfaces a non-blocking warning in the guide/chips — it must
  // not prevent a settle, so it is intentionally absent from stableNow.
  const stableNow = enoughSamples && dispersionOk && readingOk && motionOk && streamOk;
  const toleranceDeg = toleranceHalfWidth({ stdDev, sampleCount: sampleBuffer.length, smoothingAlpha });

  let confidence = Math.round(maxConfidenceBase - (range * rangePenalty) - (stdDev * stdDevPenalty));
  if (!orientationOk) confidence -= orientationPenalty;
  if (!calibrationSet) confidence -= calibrationPenalty;
  confidence = clamp(confidence, 5, 99);

  let nextSettledStart = settledStart;
  let nextAlignedStart = alignedStart;

  if (stableNow) {
    if (!nextSettledStart) nextSettledStart = now;
  } else {
    nextSettledStart = 0;
    nextAlignedStart = 0;
  }

  const settled = stableNow && (now - nextSettledStart >= settledHoldMs);
  const alignedNow = settled && Math.abs(avg) <= alignedThreshold;

  if (alignedNow) {
    if (!nextAlignedStart) nextAlignedStart = now;
  } else {
    nextAlignedStart = 0;
  }

  const aligned = alignedNow && (now - nextAlignedStart >= alignedHoldMs);

  // P0/UX: surface the single reason a settle is blocked so the UI can tell the user what to do
  // instead of leaving the workflow stuck with no explanation. Ordered most- to least-fundamental.
  let blockedBy = null;
  if (settled) blockedBy = null;
  else if (!readingOk) blockedBy = 'no-reading';
  else if (!streamOk) blockedBy = 'stream-stale';
  else if (!enoughSamples) blockedBy = 'collecting';
  else if (!motionOk) blockedBy = 'motion';
  else if (range > settledRange) blockedBy = 'spread';
  else if (stdDev > settledStdDev) blockedBy = 'jitter';
  else if (drift > driftTol) blockedBy = 'drift';
  else blockedBy = 'holding';

  return {
    avg,
    range,
    stdDev,
    drift,
    toleranceDeg,
    readingOk,
    motionOk,
    streamOk,
    blockedBy,
    // P0-4: echoed back so the UI can render the pose hint, even though it no longer gates.
    orientationOk: !!orientationOk,
    confidence,
    settled,
    aligned,
    settledStart: nextSettledStart,
    alignedStart: nextAlignedStart,
  };
}

// P0-6 helper: decide whether the device is quasi-static enough to trust a capture.
// gravityMagnitude may be in m/s^2 (~9.81) or normalized (~1); compare as a RATIO to
// the expected magnitude so units cancel. rotationRate (deg/s) is optional. Returns true
// when we cannot judge (no magnitude yet) so this never blocks the Euler-only fallback.
export function motionIsQuasiStatic({
  gravityMagnitude,
  expectedMagnitude = 9.81,
  ratioBand = 0.06,
  rotationRate = null,
  rotationTol = 8,
} = {}) {
  if (!Number.isFinite(gravityMagnitude) || gravityMagnitude <= 0) return true;
  const ratio = gravityMagnitude / expectedMagnitude;
  const magnitudeOk = Math.abs(ratio - 1) <= ratioBand;
  if (!magnitudeOk) return false;
  if (rotationRate && Number.isFinite(rotationRate.alpha) && Number.isFinite(rotationRate.beta) && Number.isFinite(rotationRate.gamma)) {
    const speed = Math.hypot(rotationRate.alpha, rotationRate.beta, rotationRate.gamma);
    if (speed > rotationTol) return false;
  }
  return true;
}

// P0-7: 180° flip trueness self-test. A healthy inclinometer reads +θ in one orientation and
// -θ after a 180° flip about the measurement axis, so the two readings should be equal and
// opposite. The residual bias = (a + b) / 2 is the constant offset that does NOT flip (sensor
// zero error, mount tilt), and the asymmetry = |a + b| measures how far the pair is from the
// ideal a == -b. `passed` is true when the residual bias stays within `tolerance` degrees, so
// callers can gate adjustment-grade wording on a recent pass. Returns null fields when either
// reading is non-finite. `corrected` = (a - b) / 2 is the bias-cancelled true angle.
export function flipSelfTest(firstReading, secondReading, tolerance = 0.2) {
  if (!Number.isFinite(firstReading) || !Number.isFinite(secondReading)) {
    return { residualBias: null, asymmetry: null, corrected: null, passed: false, tolerance };
  }
  const residualBias = (firstReading + secondReading) / 2;
  const asymmetry = Math.abs(firstReading + secondReading);
  const corrected = (firstReading - secondReading) / 2;
  return {
    residualBias,
    asymmetry,
    corrected,
    passed: Math.abs(residualBias) <= tolerance,
    tolerance,
  };
}

// --- GEOMETRIC TOE -----------------------------------------------------------------------------
// A phone cannot SENSE toe (rotation about vertical relative to the vehicle centerline; a gravity
// inclinometer is blind to it, and compass/gyro/camera fail on physics or platform). The honest,
// accurate path is GEOMETRIC measurement: the phone is the calculator + procedure coach +
// uncertainty-band engine. These helpers are PURE and use NO sensors — toe is plain atan arithmetic
// from user-entered measurements. Target accuracy ~0.1-0.3 deg. All angles are in DEGREES and use
// the exact atan (never a small-angle approximation). SIGN CONVENTION: TOE-IN is POSITIVE.

// Per-wheel toe from a front-vs-rear offset measured over a reference diameter/length D (e.g. rim
// diameter or plate height): theta = atan((rear - front) / D). rear - front > 0 means the wheel's
// leading/front edge is nearer the vehicle centerline than the trailing edge => TOE-IN => POSITIVE.
// Returns null on non-finite inputs or diameter <= 0 (output scales as 1/D, so D must be positive).
export function toeAngleFromOffset(rear, front, diameter) {
  if (!Number.isFinite(rear) || !Number.isFinite(front) || !Number.isFinite(diameter) || diameter <= 0) return null;
  return Math.atan((rear - front) / diameter) * 180 / Math.PI;
}

// TOTAL axle toe directly from a pair of plates/tapes: total = atan((rearSpan - frontSpan) /
// plateSpan), where rearSpan (R) is the distance between the two plates measured at the REAR of the
// front tires, frontSpan (F) at the FRONT, and plateSpan (S) is the plate span/height between those
// two reads. Toe-in (R > F) is positive. Returns null on non-finite inputs or plateSpan <= 0.
export function totalToeFromPlates(rearSpan, frontSpan, plateSpan) {
  if (!Number.isFinite(rearSpan) || !Number.isFinite(frontSpan) || !Number.isFinite(plateSpan) || plateSpan <= 0) return null;
  return Math.atan((rearSpan - frontSpan) / plateSpan) * 180 / Math.PI;
}

// Symmetry-assumption helper: split a TOTAL axle toe into per-wheel toe assuming left-right
// symmetry. Plates alone cannot split L vs R, so the UI must FLAG this as an assumption. Returns
// null when totalToe is non-finite.
export function perWheelFromTotal(totalToe) {
  if (!Number.isFinite(totalToe)) return null;
  return totalToe / 2;
}

// Thrust angle from the rear-axle per-wheel toe values: thrust = (toeRL - toeRR) / 2. Positive =>
// the thrust line points to the LEFT. Front per-wheel toe referenced to the geometric centerline is
// corrected to thrust-referenced by subtracting the thrust angle (sign per side) at the call site.
// Returns null when either rear toe is non-finite.
export function thrustAngle(toeRL, toeRR) {
  if (!Number.isFinite(toeRL) || !Number.isFinite(toeRR)) return null;
  return (toeRL - toeRR) / 2;
}

// Convert an angular toe to its LINEAR equivalent at a quoted spec diameter: linear =
// specDiameter * tan(angleDeg). Always pair a linear toe with the diameter it assumes. Returns null
// on non-finite inputs or specDiameter <= 0.
export function toeAngleToLinear(angleDeg, specDiameter) {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(specDiameter) || specDiameter <= 0) return null;
  return specDiameter * Math.tan(angleDeg * Math.PI / 180);
}

// Inverse of toeAngleToLinear: angle = atan(linear / specDiameter) in degrees. Returns null on
// non-finite inputs or specDiameter <= 0. Self-check: atan(1/28.648) ~= 1.999 deg ("1 inch = 2
// degrees"); atan(1/381) ~= 0.150 deg (1 mm on a 15 in wheel).
export function linearToToeAngle(linear, specDiameter) {
  if (!Number.isFinite(linear) || !Number.isFinite(specDiameter) || specDiameter <= 0) return null;
  return Math.atan(linear / specDiameter) * 180 / Math.PI;
}

// Propagated +/- band half-width (DEGREES) for a toe read. A linear read uncertainty u (default
// 0.8 mm = 1/32 in, supply in the SAME units as `diameter`) propagates as dtheta ~= u / D radians.
// For a DIFFERENTIAL of two reads (a front and a rear measurement, as every toe read is) multiply
// by sqrt(2). Reported with coverage factor k = 2 (~95%), matching the app's existing tolerance
// band. Returns null on non-finite inputs or diameter <= 0.
export function toeReadUncertaintyDeg(readUncertainty, diameter, differential = true) {
  if (!Number.isFinite(readUncertainty) || !Number.isFinite(diameter) || diameter <= 0) return null;
  const factor = differential ? Math.SQRT2 : 1;
  return 2 * (readUncertainty / diameter) * factor * 180 / Math.PI;
}

// P2-2: canonical planar (x, y) positions of the four corners in a unit square centred on the
// origin. x grows to the right (L -> R), y grows to the front (R -> F). Used to fit a plane to
// the four Level-mode corner heights so the baseline is a real least-squares plane, not a pair
// of naive two-reading deltas. The actual track/wheelbase scale cancels out of the fit's slope
// SIGN and the per-corner residuals, which is all the compensation needs.
export const CORNER_POSITIONS = {
  FL: { x: -1, y: 1 },
  FR: { x: 1, y: 1 },
  RL: { x: -1, y: -1 },
  RR: { x: 1, y: -1 },
};

// P2-2: least-squares fit of a plane z = a*x + b*y + c to a set of corner samples. Each sample
// is { x, y, z }. `a` is the left->right slope, `b` the rear->front slope, `c` the mean height.
// `residuals` keep z_measured - z_fit per corner so a non-coplanar / bad datum stands out, and
// `maxResidual` / `coplanar` summarise whether the four points actually lie on one plane within
// `tolerance`. With exactly the four unit-square corners the normal equations are diagonal, so
// the fit is exact and stable without a matrix library. Returns null when fewer than 3 finite
// points are supplied (a plane is undetermined). `points` may be an array or a {side: z} map.
export function fitPlane(points, { tolerance = 0.08 } = {}) {
  const samples = Array.isArray(points)
    ? points
    : Object.entries(points || {}).map(([side, z]) => ({ ...(CORNER_POSITIONS[side] || {}), z, side }));
  const finite = samples.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  if (finite.length < 3) return null;

  const n = finite.length;
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const p of finite) {
    sx += p.x; sy += p.y; sz += p.z;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * p.z; syz += p.y * p.z;
  }
  // Solve the 3x3 normal equations [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]] [a,b,c]^T = [sxz,syz,sz]^T
  // via Cramer's rule. det != 0 whenever the (x, y) positions are not collinear (true for the
  // four corners and any 3 of them).
  const det =
    sxx * (syy * n - sy * sy)
    - sxy * (sxy * n - sy * sx)
    + sx * (sxy * sy - syy * sx);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const detA =
    sxz * (syy * n - sy * sy)
    - sxy * (syz * n - sy * sz)
    + sx * (syz * sy - syy * sz);
  const detB =
    sxx * (syz * n - sy * sz)
    - sxz * (sxy * n - sy * sx)
    + sx * (sxy * sz - syz * sx);
  const detC =
    sxx * (syy * sz - sy * syz)
    - sxy * (sxy * sz - sx * syz)
    + sxz * (sxy * sy - syy * sx);
  const a = detA / det;
  const b = detB / det;
  const c = detC / det;

  const residuals = {};
  let maxResidual = 0;
  for (const p of finite) {
    const fit = a * p.x + b * p.y + c;
    const residual = p.z - fit;
    if (p.side) residuals[p.side] = residual;
    maxResidual = Math.max(maxResidual, Math.abs(residual));
  }
  return {
    a,
    b,
    c,
    residuals,
    maxResidual,
    coplanar: maxResidual <= tolerance,
    pointCount: n,
  };
}

// P2-2: per-corner plane height for a side from a fitted plane. This is the dimensionally-correct
// baseline compensation for level (subtract the plane height at this corner so a tilted floor does
// not contaminate the reading). Returns 0 when the plane or the corner position is unavailable.
export function planeHeightForSide(side, plane) {
  if (!plane || !Number.isFinite(plane.a) || !Number.isFinite(plane.b) || !Number.isFinite(plane.c)) return 0;
  const pos = CORNER_POSITIONS[side];
  if (!pos) return 0;
  return plane.a * pos.x + plane.b * pos.y + plane.c;
}

// P2-4: decide whether a yaw/heading reference can be trusted. iOS Safari exposes an absolute
// compass heading via webkitCompassHeading (+ webkitCompassAccuracy in degrees), while the W3C
// `absolute` flag tells us if alpha is earth-referenced at all. Indoors, magnetic distortion
// makes the heading unreliable (accuracy degrades or the heading is merely relative), so toe /
// squareness features must NOT treat raw alpha as a yaw reference. Returns a structured verdict:
//   trusted   : true only when we have an absolute heading with acceptable accuracy.
//   heading   : the usable compass heading (deg) or null.
//   reason    : short machine-friendly cause when not trusted ('relative' | 'no-heading' |
//               'poor-accuracy' | 'unavailable').
// accuracyTol is the worst webkitCompassAccuracy (deg) we still accept; negative accuracy from
// the platform means "interference / unknown" and is rejected.
export function headingTrust({
  absolute = false,
  webkitCompassHeading = null,
  webkitCompassAccuracy = null,
  accuracyTol = 25,
} = {}) {
  const hasCompass = Number.isFinite(webkitCompassHeading);
  if (hasCompass) {
    // Safari gives a real magnetometer heading. Accuracy < 0 signals interference/unknown.
    if (Number.isFinite(webkitCompassAccuracy) && (webkitCompassAccuracy < 0 || webkitCompassAccuracy > accuracyTol)) {
      return { trusted: false, heading: webkitCompassHeading, accuracy: webkitCompassAccuracy, reason: 'poor-accuracy' };
    }
    return { trusted: true, heading: webkitCompassHeading, accuracy: Number.isFinite(webkitCompassAccuracy) ? webkitCompassAccuracy : null, reason: null };
  }
  if (absolute) {
    // Earth-referenced alpha but no accuracy estimate: usable as a heading, but flagged as
    // lower trust so the UI can still warn about indoor magnetic distortion.
    return { trusted: false, heading: null, accuracy: null, reason: 'no-heading' };
  }
  return { trusted: false, heading: null, accuracy: null, reason: 'relative' };
}
