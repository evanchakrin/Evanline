export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function degToRad(value) {
  return value * Math.PI / 180;
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

export function computeSampleQuality({
  sampleBuffer = [],
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
}) {
  const range = sampleBuffer.length ? Math.max(...sampleBuffer) - Math.min(...sampleBuffer) : 0;
  const stdDev = standardDeviation(sampleBuffer);
  const avg = sampleBuffer.length ? average(sampleBuffer) : 0;
  const enoughSamples = sampleBuffer.length >= minSampleCount;
  const stableNow = enoughSamples && range <= settledRange && stdDev <= settledStdDev && orientationOk;

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
    confidence,
    settled,
    aligned,
    settledStart: nextSettledStart,
    alignedStart: nextAlignedStart,
  };
}
