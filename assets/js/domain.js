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

// Camber: phone held upright (portrait) flush against a vertical wheel face.
export function camberDeg(g) {
  if (!finiteGravity(g)) return null;
  return Math.atan2(g.x, g.y) * 180 / Math.PI;
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

  return {
    avg,
    range,
    stdDev,
    drift,
    toleranceDeg,
    readingOk,
    motionOk,
    streamOk,
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
