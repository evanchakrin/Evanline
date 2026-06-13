import {
  average,
  buildArcPath,
  clamp,
  clampAngle as clampAngleInRange,
  computeSampleQuality,
  polarPoint,
  standardDeviation,
} from './domain.js';

// v3 adds workflow/session objects beyond the older v2 zero + readings payload, so loadState() migrates legacy data forward on first read.
const STORAGE_KEY = 'evanline-state-v3';
const MODES = ['camber', 'toe', 'level', 'pitch'];
const SIDES = ['FL', 'FR', 'RL', 'RR'];
const MAX_STORED_MEASUREMENTS = 32;
const MAX_FIXTURE_PROFILES = 12;
const NOTICE_DISPLAY_MS = 2600;
const MAX_CONFIDENCE_BASE = 98;
const ORIENTATION_PENALTY = 30;
const CALIBRATION_PENALTY = 12;
const RANGE_PENALTY = 260;
const STDDEV_PENALTY = 420;
const ALIGNED_HOLD_MS = 500;
const MODE_LABELS = {
  camber: 'Camber Angle',
  toe: 'Toe Angle',
  level: 'Level (Left / Right)',
  pitch: 'Pitch Angle (Front / Back)',
};
// placement/orientation/calibration copy for the guided workflow card
const MODE_GUIDES = {
  camber: {
    placement: 'Placement: Flush to wheel face, screen outward',
    orientation: 'Portrait',
    calibration: 'Zero against a known vertical or repeatable reference before reading camber.',
  },
  toe: {
    placement: 'Placement: Against wheel or straight edge, pointing forward',
    orientation: 'Portrait',
    calibration: 'Zero against a straight-ahead reference before comparing left and right toe.',
  },
  level: {
    placement: 'Placement: On a flat sill, roof, or hub surface',
    orientation: 'Landscape',
    calibration: 'Zero on a confirmed level surface if you need a relative reference.',
  },
  pitch: {
    placement: 'Placement: Front-to-back on a flat reference surface',
    orientation: 'Landscape',
    calibration: 'Zero on a known flat reference before checking pitch or driveway slope.',
  },
};
const CX = 150, CY = 168, R = 126;
const START_DEG = -180, END_DEG = 0;
const GAUGE_RANGE = 30;
const ALIGNED_THRESHOLD = 0.3;
const SMOOTHING_ALPHA = 0.22;
const SAMPLE_WINDOW = 12;
const MIN_SAMPLE_COUNT = 6;
const SETTLED_RANGE = 0.18;
const SETTLED_STDDEV = 0.08;
const SETTLED_HOLD_MS = 900;
const PRECISION_CAPTURE_TARGET = 3;
const BASELINE_CAPTURE_TARGET = 2;
const MIN_PRECISION_CAPTURES_READY = 2;
const REPEATABILITY_RANGE_FACTOR = 120;
const REPEATABILITY_STDDEV_FACTOR = 220;
const REPEATABILITY_REVERSAL_FACTOR = 70;
const REVERSAL_REQUIRED_MISSING_PENALTY = 18;
const REVERSAL_OPTIONAL_MISSING_PENALTY = 8;
const FORWARD_CAPTURE_TARGET = 3;
const REVERSE_CAPTURE_TARGET = 2;
const INSUFFICIENT_CAPTURE_PENALTY = 10;
const ADJUSTMENT_QUALITY_THRESHOLD = 88;
const COMPARISON_QUALITY_THRESHOLD = 68;
const MAX_ACCEPTABLE_REVERSAL_BIAS = 0.08;
const BASELINE_QUALITY_PENALTIES = {
  Trusted: 0,
  Approximate: 8,
  Noisy: 18,
};

const state = {
  mode: 'camber',
  workflow: 'quick',
  alpha: 0,
  beta: 0,
  gamma: 0,
  smoothed: { alpha: null, beta: null, gamma: null },
  calibrationOffsets: defaultOffsets(),
  calibrationMeta: defaultCalibrationMeta(),
  deviceProfile: null,
  fixtureProfiles: [],
  precisionSession: defaultPrecisionSession(),
  sampleBuffer: [],
  confidence: 0,
  settled: false,
  settledStart: 0,
  aligned: false,
  alignedStart: 0,
  locked: false,
  sensorsAvailable: false,
  sensorListenerAttached: false,
  prevScreen: null,
  selectedSide: 'FL',
  measurements: [],
  screenOrientation: 'portrait',
  orientationOk: true,
  notice: null,
  liveRefreshScheduled: false,
};

function defaultOffsets() {
  return { camber: 0, toe: 0, level: 0, pitch: 0 };
}

function defaultCalibrationMeta() {
  return { camber: null, toe: null, level: null, pitch: null };
}

function defaultPrecisionSession() {
  return {
    startedAt: new Date().toISOString(),
    fixtureId: '',
    baselinePoints: SIDES.reduce((acc, side) => {
      acc[side] = [];
      return acc;
    }, {}),
    captures: {},
  };
}

function measurementKey(mode, side) {
  return `${mode}:${side}`;
}

function readStoredState() {
  const v3Raw = localStorage.getItem(STORAGE_KEY);
  if (v3Raw) {
    try {
      return JSON.parse(v3Raw);
    } catch (error) {
      console.warn('Unable to parse v3 Evanline state, attempting legacy fallback.', error);
    }
  }

  const legacyRaw = localStorage.getItem('evanline-state-v2');
  if (!legacyRaw) return null;
  let parsed;
  try {
    parsed = JSON.parse(legacyRaw);
  } catch (error) {
    console.warn('Unable to parse legacy Evanline state.', error);
    return null;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch (error) {
    console.warn('Unable to migrate legacy Evanline state to v3 storage.', error);
  }
  return parsed;
}

function clampAngle(angle) {
  return clampAngleInRange(angle, GAUGE_RANGE);
}

function initGaugeSVG() {
  const bgArc = document.getElementById('gauge-bg-arc');
  const colArc = document.getElementById('gauge-arc');
  const ticks = document.getElementById('gauge-ticks');
  const labels = document.getElementById('gauge-tick-labels');
  const path = buildArcPath(CX, CY, R, START_DEG, END_DEG);

  bgArc.setAttribute('d', path);
  colArc.setAttribute('d', path);
  ticks.innerHTML = '';
  labels.innerHTML = '';

  for (let v = -GAUGE_RANGE; v <= GAUGE_RANGE; v += 5) {
    const outer = polarPoint(CX, CY, R + 10, START_DEG + (v + GAUGE_RANGE) / (2 * GAUGE_RANGE) * 180);
    const inner = polarPoint(CX, CY, R - 10, START_DEG + (v + GAUGE_RANGE) / (2 * GAUGE_RANGE) * 180);
    const isMajor = v % 10 === 0;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', outer.x);
    line.setAttribute('y1', outer.y);
    line.setAttribute('x2', inner.x);
    line.setAttribute('y2', inner.y);
    line.setAttribute('stroke-width', isMajor ? '2' : '1');
    ticks.appendChild(line);

    if (isMajor) {
      const labelPoint = polarPoint(CX, CY, R + 22, START_DEG + (v + GAUGE_RANGE) / (2 * GAUGE_RANGE) * 180);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', labelPoint.x);
      text.setAttribute('y', labelPoint.y + 4);
      text.textContent = v === 0 ? '0' : (v > 0 ? `+${v}` : `${v}`);
      labels.appendChild(text);
    }
  }
}

function drawBubble(angle) {
  const canvas = document.getElementById('bubble-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const mx = W / 2;
  const my = H / 2;
  const tubeW = W - 32;
  const tubeH = 34;
  const tubeR = tubeH / 2;
  const tx = 16;
  const ty = my - tubeR;

  ctx.clearRect(0, 0, W, H);

  ctx.beginPath();
  ctx.moveTo(tx + tubeR, ty);
  ctx.lineTo(tx + tubeW - tubeR, ty);
  ctx.arcTo(tx + tubeW, ty, tx + tubeW, ty + tubeH, tubeR);
  ctx.lineTo(tx + tubeW, ty + tubeH - tubeR);
  ctx.arcTo(tx + tubeW, ty + tubeH, tx + tubeW - tubeR, ty + tubeH, tubeR);
  ctx.lineTo(tx + tubeR, ty + tubeH);
  ctx.arcTo(tx, ty + tubeH, tx, ty + tubeH - tubeR, tubeR);
  ctx.lineTo(tx, ty + tubeR);
  ctx.arcTo(tx, ty, tx + tubeR, ty, tubeR);
  ctx.closePath();
  ctx.fillStyle = '#21262d';
  ctx.fill();
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx, ty + 4);
  ctx.lineTo(mx, ty + tubeH - 4);
  ctx.stroke();
  ctx.setLineDash([]);

  const clampedAngle = clampAngle(angle);
  const bubbleX = mx - (clampedAngle / GAUGE_RANGE) * (tubeW / 2 - tubeR - 2);
  const bubbleR = 12;
  const isLevel = Math.abs(angle) < 0.5;
  const bubbleColour = isLevel ? '#3fb950' : (Math.abs(angle) < 3 ? '#d29922' : '#f85149');
  const gradient = ctx.createRadialGradient(bubbleX - 3, my - 4, 2, bubbleX, my, bubbleR);

  gradient.addColorStop(0, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, bubbleColour + 'aa');

  ctx.beginPath();
  ctx.arc(bubbleX, my, bubbleR, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = bubbleColour;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#8b949e';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${formatNumber(angle)}°`, mx, ty + tubeH + 16);
}

function updateNeedle(angleDeg) {
  const clampedAngle = clampAngle(angleDeg);
  const rotDeg = (clampedAngle / GAUGE_RANGE) * 90;
  const needle = document.getElementById('gauge-needle');
  const display = document.getElementById('angle-display');
  const badge = document.getElementById('aligned-badge');
  const svgText = document.getElementById('svg-aligned-text');
  const abs = Math.abs(angleDeg);

  needle.setAttribute('transform', `rotate(${rotDeg},${CX},${CY})`);
  display.textContent = formatNumber(abs);

  if (state.aligned) {
    display.style.color = 'var(--green)';
    badge.classList.add('visible');
    svgText.setAttribute('opacity', '1');
    svgText.textContent = '● Settled & aligned';
  } else {
    badge.classList.remove('visible');
    svgText.setAttribute('opacity', '0');
    svgText.textContent = '';
    if (abs < 1.5) display.style.color = 'var(--text)';
    else if (abs < 3) display.style.color = 'var(--yellow)';
    else display.style.color = 'var(--red)';
  }

  document.getElementById('angle-direction').textContent = directionLabel(angleDeg);
}

function directionLabel(angleDeg) {
  if (state.mode === 'camber') {
    return angleDeg > 0.15 ? '▲ Positive Camber' : angleDeg < -0.15 ? '▼ Negative Camber' : '— Zero Camber';
  }
  if (state.mode === 'toe') {
    return angleDeg > 0.15 ? '→ Toe Out' : angleDeg < -0.15 ? '← Toe In' : '— Neutral';
  }
  if (state.mode === 'level') {
    return angleDeg > 0.15 ? '↗ Tilts Right' : angleDeg < -0.15 ? '↖ Tilts Left' : '— Level';
  }
  return angleDeg > 0.15 ? '↑ Nose Up' : angleDeg < -0.15 ? '↓ Nose Down' : '— Flat';
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}°`;
}

function formatTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function captureSeriesStats(series = []) {
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

function activeFixture() {
  return state.fixtureProfiles.find(item => item.id === state.precisionSession.fixtureId) || null;
}

function ensurePrecisionBucket(mode = state.mode, side = state.selectedSide) {
  const key = measurementKey(mode, side);
  if (!state.precisionSession.captures[key]) {
    state.precisionSession.captures[key] = {
      mode,
      side,
      forward: [],
      reverse: [],
    };
  }
  return state.precisionSession.captures[key];
}

function buildCaptureSnapshot() {
  return {
    value: Number(sampleAverage().toFixed(3)),
    confidence: state.confidence,
    samples: state.sampleBuffer.length,
    range: Number(sampleRange().toFixed(3)),
    stdDev: Number(sampleStdDev().toFixed(3)),
    orientation: state.screenOrientation,
    time: new Date().toISOString(),
  };
}

function baselineStatsForSide(side) {
  const series = state.precisionSession.baselinePoints?.[side] || [];
  return captureSeriesStats(series);
}

function baselineSummary() {
  const sideStats = SIDES.reduce((acc, side) => {
    const stats = baselineStatsForSide(side);
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

  if (completedSides === SIDES.length) {
    if (worstStdDev <= 0.06 && worstRange <= 0.16) {
      label = 'Trusted';
      tone = 'good';
    } else if (worstStdDev <= 0.14 && worstRange <= 0.3) {
      label = 'Approximate';
    } else {
      label = 'Noisy';
    }
  }

  return {
    sideStats,
    completedSides,
    complete: completedSides === SIDES.length,
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

function baselineCompensationForSide(side, mode, summary = baselineSummary()) {
  if (!summary.complete) return 0;
  if (mode === 'camber' || mode === 'level') {
    const stats = summary.sideStats[side];
    return stats ? stats.mean - summary.overallMean : 0;
  }
  return 0;
}

function precisionSummary(mode = state.mode, side = state.selectedSide) {
  const key = measurementKey(mode, side);
  const bucket = state.precisionSession.captures[key] || {
    mode,
    side,
    forward: [],
    reverse: [],
  };
  const forward = captureSeriesStats(bucket.forward);
  const reverse = captureSeriesStats(bucket.reverse);
  const baseline = baselineSummary();
  const fixture = activeFixture();
  const needsReverse = !!fixture?.reversible;
  const forwardReady = !!forward && forward.count >= MIN_PRECISION_CAPTURES_READY;
  const reverseReady = !!reverse && reverse.count >= MIN_PRECISION_CAPTURES_READY;
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
    ? (needsReverse ? REVERSAL_REQUIRED_MISSING_PENALTY : REVERSAL_OPTIONAL_MISSING_PENALTY)
    : Math.abs(reversalBias) * REPEATABILITY_REVERSAL_FACTOR;
  const baselinePenalty = !baseline.complete ? BASELINE_QUALITY_PENALTIES.Noisy : (BASELINE_QUALITY_PENALTIES[baseline.label] ?? BASELINE_QUALITY_PENALTIES.Noisy);
  const capturePenalty = Math.max(0, FORWARD_CAPTURE_TARGET - (forward?.count || 0)) * INSUFFICIENT_CAPTURE_PENALTY
    + (needsReverse ? Math.max(0, REVERSE_CAPTURE_TARGET - (reverse?.count || 0)) * INSUFFICIENT_CAPTURE_PENALTY : 0);
  const repeatabilityScore = clamp(
    Math.round(100 - (rangePenalty * REPEATABILITY_RANGE_FACTOR) - (deviationPenalty * REPEATABILITY_STDDEV_FACTOR) - reversalPenalty - baselinePenalty - capturePenalty),
    5,
    99
  );

  let verdict = 'Need more captures';
  if (forwardReady && (!needsReverse || reverseReady)) {
    if (repeatabilityScore >= ADJUSTMENT_QUALITY_THRESHOLD && baseline.label === 'Trusted' && (!needsReverse || Math.abs(reversalBias || 0) <= MAX_ACCEPTABLE_REVERSAL_BIAS)) {
      verdict = 'Good enough for adjustment';
    } else if (repeatabilityScore >= COMPARISON_QUALITY_THRESHOLD) {
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

function currentOrientation() {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

function preferredOrientation(mode = state.mode) {
  return (mode === 'camber' || mode === 'toe') ? 'portrait' : 'landscape';
}

function orientationLabel(value) {
  return value === 'landscape' ? 'Landscape' : 'Portrait';
}

function rawAngleForMode(mode = state.mode, source = state.smoothed) {
  const bank = source || state;
  const axis = mode === 'pitch' ? 'beta' : 'gamma';
  const value = bank[axis];
  const deviceBias = axis === 'beta'
    ? (state.deviceProfile?.axisBias?.beta || 0)
    : (state.deviceProfile?.axisBias?.gamma || 0);
  return Number.isFinite(value) ? value - deviceBias : 0;
}

function calibratedAngle(mode = state.mode) {
  return rawAngleForMode(mode) - (state.calibrationOffsets[mode] || 0);
}

function sampleAverage() {
  if (!state.sampleBuffer.length) return calibratedAngle();
  return average(state.sampleBuffer);
}

function sampleRange() {
  if (!state.sampleBuffer.length) return 0;
  return Math.max(...state.sampleBuffer) - Math.min(...state.sampleBuffer);
}

function sampleStdDev() {
  return standardDeviation(state.sampleBuffer);
}

function resetLiveAveraging() {
  state.sampleBuffer = [];
  state.confidence = 0;
  state.settled = false;
  state.settledStart = 0;
  state.aligned = false;
  state.alignedStart = 0;
}

function pushSample(value) {
  state.sampleBuffer.push(value);
  if (state.sampleBuffer.length > SAMPLE_WINDOW) {
    state.sampleBuffer.shift();
  }
}

function updateSampleQuality() {
  const result = computeSampleQuality({
    sampleBuffer: state.sampleBuffer,
    orientationOk: state.orientationOk,
    calibrationSet: !!state.calibrationMeta[state.mode],
    now: Date.now(),
    settledStart: state.settledStart,
    alignedStart: state.alignedStart,
    alignedThreshold: ALIGNED_THRESHOLD,
    minSampleCount: MIN_SAMPLE_COUNT,
    settledRange: SETTLED_RANGE,
    settledStdDev: SETTLED_STDDEV,
    settledHoldMs: SETTLED_HOLD_MS,
    alignedHoldMs: ALIGNED_HOLD_MS,
    maxConfidenceBase: MAX_CONFIDENCE_BASE,
    rangePenalty: RANGE_PENALTY,
    stdDevPenalty: STDDEV_PENALTY,
    orientationPenalty: ORIENTATION_PENALTY,
    calibrationPenalty: CALIBRATION_PENALTY,
  });
  state.settledStart = result.settledStart;
  state.alignedStart = result.alignedStart;
  state.settled = result.settled;
  state.aligned = result.aligned;
  state.confidence = result.confidence;
}

function loadState() {
  try {
    const parsed = readStoredState();
    if (!parsed) return;
    const offsets = defaultOffsets();
    MODES.forEach(mode => {
      const value = parsed?.calibrationOffsets?.[mode];
      offsets[mode] = Number.isFinite(value) ? value : 0;
    });
    const meta = defaultCalibrationMeta();
    MODES.forEach(mode => {
      const item = parsed?.calibrationMeta?.[mode];
      if (item && Number.isFinite(item.offset) && typeof item.time === 'string') {
        meta[mode] = {
          offset: item.offset,
          time: item.time,
          orientation: item.orientation === 'landscape' ? 'landscape' : 'portrait',
        };
      }
    });

    const measurements = Array.isArray(parsed?.measurements) ? parsed.measurements : [];
    const fixtureProfiles = Array.isArray(parsed?.fixtureProfiles) ? parsed.fixtureProfiles : [];
    const normalizedFixtures = fixtureProfiles
      .filter(item => item && typeof item.name === 'string' && item.name.trim())
      .slice(0, MAX_FIXTURE_PROFILES)
      .map((item, index) => ({
        id: typeof item.id === 'string' && item.id ? item.id : `fixture-${index + 1}`,
        name: item.name.trim(),
        reversible: !!item.reversible,
        notes: typeof item.notes === 'string' ? item.notes : '',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
        lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
      }));
    const parsedSession = parsed?.precisionSession || {};
    const baselinePoints = SIDES.reduce((acc, side) => {
      const series = Array.isArray(parsedSession?.baselinePoints?.[side]) ? parsedSession.baselinePoints[side] : [];
      acc[side] = series
        .filter(item => Number.isFinite(item?.value))
        .map(item => ({
          value: Number(item.value),
          confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
          samples: Number.isFinite(item.samples) ? item.samples : 0,
          range: Number.isFinite(item.range) ? item.range : 0,
          stdDev: Number.isFinite(item.stdDev) ? item.stdDev : 0,
          orientation: item.orientation === 'landscape' ? 'landscape' : 'portrait',
          time: typeof item.time === 'string' ? item.time : new Date().toISOString(),
        }));
      return acc;
    }, {});
    const captures = {};
    const rawCaptures = parsedSession?.captures && typeof parsedSession.captures === 'object' ? parsedSession.captures : {};
    Object.entries(rawCaptures).forEach(([key, item]) => {
      if (!item || !MODES.includes(item.mode) || !SIDES.includes(item.side)) return;
      const normalizeSeries = series => (Array.isArray(series) ? series : [])
        .filter(entry => Number.isFinite(entry?.value))
        .map(entry => ({
          value: Number(entry.value),
          confidence: Number.isFinite(entry.confidence) ? entry.confidence : 0,
          samples: Number.isFinite(entry.samples) ? entry.samples : 0,
          range: Number.isFinite(entry.range) ? entry.range : 0,
          stdDev: Number.isFinite(entry.stdDev) ? entry.stdDev : 0,
          orientation: entry.orientation === 'landscape' ? 'landscape' : 'portrait',
          time: typeof entry.time === 'string' ? entry.time : new Date().toISOString(),
        }));
      captures[key] = {
        mode: item.mode,
        side: item.side,
        forward: normalizeSeries(item.forward),
        reverse: normalizeSeries(item.reverse),
      };
    });

    state.calibrationOffsets = offsets;
    state.calibrationMeta = meta;
    state.workflow = parsed?.workflow === 'precision' ? 'precision' : 'quick';
    state.deviceProfile = parsed?.deviceProfile && parsed.deviceProfile.axisBias
      ? {
          label: typeof parsed.deviceProfile.label === 'string' ? parsed.deviceProfile.label : 'Trusted reference',
          time: typeof parsed.deviceProfile.time === 'string' ? parsed.deviceProfile.time : new Date().toISOString(),
          axisBias: {
            beta: Number.isFinite(parsed.deviceProfile.axisBias.beta) ? parsed.deviceProfile.axisBias.beta : 0,
            gamma: Number.isFinite(parsed.deviceProfile.axisBias.gamma) ? parsed.deviceProfile.axisBias.gamma : 0,
          },
        }
      : null;
    state.fixtureProfiles = normalizedFixtures;
    state.precisionSession = {
      startedAt: typeof parsedSession.startedAt === 'string' ? parsedSession.startedAt : new Date().toISOString(),
      fixtureId: normalizedFixtures.some(item => item.id === parsedSession.fixtureId) ? parsedSession.fixtureId : '',
      baselinePoints,
      captures,
    };
    state.measurements = measurements
      .filter(item => MODES.includes(item.mode) && SIDES.includes(item.side) && Number.isFinite(item.value))
      .map(item => ({
        id: `${item.mode}-${item.side}`,
        mode: item.mode,
        side: item.side,
        value: Number(item.value),
        confidence: Number.isFinite(item.confidence) ? item.confidence : 0,
        samples: Number.isFinite(item.samples) ? item.samples : 0,
        time: typeof item.time === 'string' ? item.time : new Date().toISOString(),
        workflow: item.workflow === 'precision' ? 'precision' : 'quick',
        rawValue: Number.isFinite(item.rawValue) ? Number(item.rawValue) : null,
        correctedValue: Number.isFinite(item.correctedValue) ? Number(item.correctedValue) : null,
        reversalBias: Number.isFinite(item.reversalBias) ? Number(item.reversalBias) : null,
        repeatabilityScore: Number.isFinite(item.repeatabilityScore) ? item.repeatabilityScore : null,
        captureCount: Number.isFinite(item.captureCount) ? item.captureCount : null,
        baselineQuality: typeof item.baselineQuality === 'string' ? item.baselineQuality : null,
        trustVerdict: typeof item.trustVerdict === 'string' ? item.trustVerdict : null,
        fixtureId: typeof item.fixtureId === 'string' ? item.fixtureId : '',
      }));
  } catch (error) {
    state.calibrationOffsets = defaultOffsets();
    state.calibrationMeta = defaultCalibrationMeta();
    state.workflow = 'quick';
    state.deviceProfile = null;
    state.fixtureProfiles = [];
    state.precisionSession = defaultPrecisionSession();
    state.measurements = [];
    console.warn('Unable to restore saved Evanline state.', error);
    state.notice = {
      text: 'Saved calibration could not be restored. Local storage may be unavailable.',
      tone: 'warn',
      until: Date.now() + NOTICE_DISPLAY_MS,
    };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      workflow: state.workflow,
      calibrationOffsets: state.calibrationOffsets,
      calibrationMeta: state.calibrationMeta,
      deviceProfile: state.deviceProfile,
      fixtureProfiles: state.fixtureProfiles,
      precisionSession: state.precisionSession,
      measurements: state.measurements.slice(-MAX_STORED_MEASUREMENTS),
    }));
  } catch (error) {
    console.warn('Unable to persist Evanline state.', error);
    state.notice = {
      text: 'Local storage is unavailable, so saved zeros and readings may not persist.',
      tone: 'warn',
      until: Date.now() + NOTICE_DISPLAY_MS,
    };
  }
}

function setNotice(text, tone = 'warn') {
  state.notice = {
    text,
    tone,
    until: Date.now() + NOTICE_DISPLAY_MS,
  };
}

function activeNotice() {
  if (!state.notice) return null;
  if (Date.now() > state.notice.until) {
    state.notice = null;
    return null;
  }
  return state.notice;
}

function attachSensorListener() {
  if (state.sensorListenerAttached) return;
  window.addEventListener('deviceorientation', onOrientation, true);
  state.sensorListenerAttached = true;
}

function onOrientation(event) {
  if (state.locked) return;

  state.alpha = Number.isFinite(event.alpha) ? event.alpha : 0;
  state.beta = Number.isFinite(event.beta) ? event.beta : 0;
  state.gamma = Number.isFinite(event.gamma) ? event.gamma : 0;

  ['alpha', 'beta', 'gamma'].forEach(axis => {
    const next = state[axis];
    const prev = state.smoothed[axis];
    state.smoothed[axis] = prev === null ? next : prev + (next - prev) * SMOOTHING_ALPHA;
  });

  state.screenOrientation = currentOrientation();
  state.orientationOk = state.screenOrientation === preferredOrientation();

  pushSample(calibratedAngle());
  updateSampleQuality();
  scheduleLiveRefresh();
}

function requestSensors(callback) {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(response => {
        if (response === 'granted') {
          attachSensorListener();
          state.sensorsAvailable = true;
          hideSensorBanner();
        } else {
          showSensorBanner();
        }
        refreshUI();
        if (callback) callback(response === 'granted');
      })
      .catch(() => {
        showSensorBanner();
        refreshUI();
        if (callback) callback(false);
      });
  } else if (typeof DeviceOrientationEvent !== 'undefined') {
    attachSensorListener();
    state.sensorsAvailable = true;
    hideSensorBanner();
    refreshUI();
    if (callback) callback(true);
  } else {
    showSensorBanner();
    refreshUI();
    if (callback) callback(false);
  }
}

function showSensorBanner() {
  document.getElementById('sensor-banner').classList.remove('hidden');
}

function hideSensorBanner() {
  document.getElementById('sensor-banner').classList.add('hidden');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.toggle('hidden', screen.id !== id);
  });
}

function startApp() {
  requestSensors(ok => {
    showScreen('screen-main');
    initGaugeSVG();
    drawBubble(sampleAverage());
    if (!ok) showSensorBanner();
    refreshUI();
  });
}

function showInstructions() {
  state.prevScreen = document.querySelector('.screen:not(.hidden)')?.id || 'screen-welcome';
  showScreen('screen-instructions');
}

function backFromInstructions() {
  showScreen(state.prevScreen || 'screen-welcome');
}

function setWorkflow(workflow) {
  state.workflow = workflow === 'precision' ? 'precision' : 'quick';
  if (state.workflow === 'precision' && !state.precisionSession.startedAt) {
    state.precisionSession = defaultPrecisionSession();
  }
  saveState();
  refreshUI();
}

function selectSide(side) {
  state.selectedSide = side;
  refreshUI();
}

function selectFixture(id) {
  state.precisionSession.fixtureId = state.fixtureProfiles.some(item => item.id === id) ? id : '';
  const fixture = activeFixture();
  if (fixture) fixture.lastUsedAt = new Date().toISOString();
  saveState();
  refreshUI();
}

function createOrUpdateFixture() {
  const current = activeFixture();
  const defaultName = current?.name || `Fixture ${state.fixtureProfiles.length + 1}`;
  const name = window.prompt('Fixture profile name', defaultName);
  if (!name || !name.trim()) return;
  const notes = window.prompt('Fixture notes (contact points, wheel type, printed jig version)', current?.notes || '3-point wheel-face jig') || '';
  const reversible = window.confirm('Can this fixture be flipped or mirrored for reversal checks?');
  const id = current?.id || `fixture-${Date.now()}`;
  const profile = {
    id,
    name: name.trim(),
    reversible,
    notes: notes.trim(),
    createdAt: current?.createdAt || new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  state.fixtureProfiles = [...state.fixtureProfiles.filter(item => item.id !== id), profile].slice(-MAX_FIXTURE_PROFILES);
  state.precisionSession.fixtureId = id;
  saveState();
  setNotice(`Fixture profile "${profile.name}" saved.`, 'good');
  refreshUI();
}

function resetPrecisionSession() {
  const fixtureId = state.precisionSession.fixtureId;
  state.precisionSession = defaultPrecisionSession();
  state.precisionSession.fixtureId = fixtureId;
  saveState();
  setNotice('Precision session reset. Fixture selection was kept.', 'warn');
  refreshUI();
}

function setMode(mode) {
  state.mode = mode;
  state.screenOrientation = currentOrientation();
  state.orientationOk = state.screenOrientation === preferredOrientation(mode);
  resetLiveAveraging();
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
  refreshUI();
}

function captureDeviceCalibration() {
  if (!state.settled) {
    setNotice('Hold the phone on a trusted reference until it settles before capturing device bias.', 'warn');
    refreshUI();
    return;
  }
  const label = window.prompt('Device reference label', state.deviceProfile?.label || 'Trusted reference');
  if (label === null) return;
  state.deviceProfile = {
    label: label.trim() || 'Trusted reference',
    time: new Date().toISOString(),
    axisBias: {
      beta: Number((state.smoothed.beta || 0).toFixed(3)),
      gamma: Number((state.smoothed.gamma || 0).toFixed(3)),
    },
  };
  resetLiveAveraging();
  saveState();
  setNotice('Device reference captured and applied across modes.', 'good');
  refreshUI();
}

function resetDeviceCalibration() {
  state.deviceProfile = null;
  resetLiveAveraging();
  saveState();
  setNotice('Device reference reset.', 'warn');
  refreshUI();
}

function calibrate() {
  const raw = rawAngleForMode();
  state.calibrationOffsets[state.mode] = raw;
  state.calibrationMeta[state.mode] = {
    offset: raw,
    time: new Date().toISOString(),
    orientation: state.screenOrientation,
  };
  resetLiveAveraging();
  saveState();
  setNotice(`${MODE_LABELS[state.mode]} set to zero and saved locally.`, 'good');
  refreshUI();
}

function resetCalibration() {
  state.calibrationOffsets[state.mode] = 0;
  state.calibrationMeta[state.mode] = null;
  resetLiveAveraging();
  saveState();
  setNotice(`${MODE_LABELS[state.mode]} calibration reset.`, 'warn');
  refreshUI();
}

function toggleLock() {
  state.locked = !state.locked;
  if (!state.locked) {
    resetLiveAveraging();
  }
  const noticeText = state.locked ? 'Reading locked. Save the average or tap Resume Live.' : 'Live reading resumed.';
  const noticeTone = state.locked ? 'good' : 'warn';
  setNotice(noticeText, noticeTone);
  refreshUI();
}

function captureBaselinePoint(side) {
  if (state.workflow !== 'precision') {
    setNotice('Switch to Precision workflow to capture a baseline plane.', 'warn');
    refreshUI();
    return;
  }
  if (state.mode !== 'level') {
    setNotice('Baseline points use Level mode so the whole session shares one plane reference.', 'warn');
    refreshUI();
    return;
  }
  if (!state.settled) {
    setNotice('Hold the phone steady until the Level reading settles before capturing a baseline point.', 'warn');
    refreshUI();
    return;
  }
  state.precisionSession.baselinePoints[side].push(buildCaptureSnapshot());
  state.precisionSession.baselinePoints[side] = state.precisionSession.baselinePoints[side].slice(-PRECISION_CAPTURE_TARGET);
  saveState();
  setNotice(`Captured baseline point for ${side}.`, 'good');
  refreshUI();
}

function capturePrecisionReading(direction) {
  if (state.workflow !== 'precision') {
    setNotice('Switch to Precision workflow to build a repeated capture set.', 'warn');
    refreshUI();
    return;
  }
  if (!activeFixture()) {
    setNotice('Select or save a fixture profile before precision captures.', 'warn');
    refreshUI();
    return;
  }
  if (state.mode !== 'level' && !baselineSummary().complete) {
    setNotice('Capture FL, FR, RL, and RR baseline points in Level mode before precision wheel readings.', 'warn');
    refreshUI();
    return;
  }
  if (!state.settled) {
    setNotice('Hold the phone steady until the reading settles before capturing.', 'warn');
    refreshUI();
    return;
  }

  const bucket = ensurePrecisionBucket(state.mode, state.selectedSide);
  bucket[direction].push(buildCaptureSnapshot());
  bucket[direction] = bucket[direction].slice(-PRECISION_CAPTURE_TARGET);
  saveState();
  setNotice(`Captured ${direction === 'reverse' ? 'reversed' : 'forward'} precision reading for ${state.mode} ${state.selectedSide}.`, 'good');
  refreshUI();
}

function saveQuickMeasurement() {
  if (!state.sampleBuffer.length) {
    setNotice('Wait for a few sensor samples before saving.', 'warn');
    refreshUI();
    return;
  }
  if (!state.settled) {
    setNotice('Hold the phone steady until the reading settles before saving.', 'warn');
    refreshUI();
    return;
  }

  const measurement = {
    id: `${state.mode}-${state.selectedSide}`,
    mode: state.mode,
    side: state.selectedSide,
    value: Number(sampleAverage().toFixed(2)),
    confidence: state.confidence,
    samples: state.sampleBuffer.length,
    time: new Date().toISOString(),
    workflow: 'quick',
    rawValue: null,
    correctedValue: null,
    reversalBias: null,
    repeatabilityScore: null,
    captureCount: state.sampleBuffer.length,
    baselineQuality: null,
    trustVerdict: null,
    fixtureId: '',
  };

  state.measurements = state.measurements.filter(item => !(item.mode === measurement.mode && item.side === measurement.side));
  state.measurements.push(measurement);
  saveState();
  setNotice(`Saved averaged ${state.mode} reading for ${state.selectedSide}.`, 'good');
  refreshUI();
}

function savePrecisionMeasurement() {
  const summary = precisionSummary(state.mode, state.selectedSide);
  if (!summary.readyToSave || !Number.isFinite(summary.finalValue)) {
    setNotice('Precision save needs repeated settled captures and, for reversible fixtures, both forward and reversed sets.', 'warn');
    refreshUI();
    return;
  }

  const measurement = {
    id: `${state.mode}-${state.selectedSide}`,
    mode: state.mode,
    side: state.selectedSide,
    value: Number(summary.finalValue.toFixed(2)),
    // Precision confidence averages live stability with cross-capture agreement so one shaky moment or one clean batch cannot dominate the saved trust signal by itself.
    confidence: Math.round((state.confidence + summary.repeatabilityScore) / 2),
    samples: (summary.forward?.count || 0) + (summary.reverse?.count || 0),
    time: new Date().toISOString(),
    workflow: 'precision',
    rawValue: Number((summary.forwardOnlyValue ?? 0).toFixed(3)),
    correctedValue: Number((summary.reversalCorrectedValue ?? 0).toFixed(3)),
    reversalBias: summary.reversalBias === null ? null : Number(summary.reversalBias.toFixed(3)),
    repeatabilityScore: summary.repeatabilityScore,
    captureCount: (summary.forward?.count || 0) + (summary.reverse?.count || 0),
    baselineQuality: summary.baseline.label,
    trustVerdict: summary.verdict,
    fixtureId: state.precisionSession.fixtureId,
  };

  state.measurements = state.measurements.filter(item => !(item.mode === measurement.mode && item.side === measurement.side));
  state.measurements.push(measurement);
  saveState();
  setNotice(`Saved precision ${state.mode} reading for ${state.selectedSide}.`, 'good');
  refreshUI();
}

function saveMeasurement() {
  if (state.workflow === 'precision') {
    savePrecisionMeasurement();
    return;
  }
  saveQuickMeasurement();
}

function measurementFor(mode, side) {
  return state.measurements.find(item => item.mode === mode && item.side === side) || null;
}

function hasSavedLevelReading() {
  return SIDES.some(side => measurementFor('level', side));
}

function deltaFor(mode, leftSide, rightSide) {
  const left = measurementFor(mode, leftSide);
  const right = measurementFor(mode, rightSide);
  if (!left || !right) return null;
  return left.value - right.value;
}

function buildElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function refreshGuide() {
  const guide = MODE_GUIDES[state.mode];
  const notice = activeNotice();
  const levelPrepared = !!(state.calibrationMeta.level || hasSavedLevelReading());
  const precision = precisionSummary(state.mode, state.selectedSide);
  const baseline = precision.baseline;
  let title = '1. Verify level surface';
  let description = 'Use Level mode before alignment readings so your baseline is trustworthy.';
  let warning = 'Waiting for sensor permission.';
  let tone = 'warn';

  if (!state.sensorsAvailable) {
    warning = 'Enable motion access in Safari to begin measuring.';
  } else if (notice) {
    warning = notice.text;
    tone = notice.tone;
  } else if (state.workflow === 'precision' && !state.deviceProfile) {
    title = '1. Capture device reference';
    description = 'Place the phone on a trusted reference and capture device bias before trusting a precision session.';
    warning = 'Device reference is not set yet.';
  } else if (state.workflow === 'precision' && !activeFixture()) {
    title = '2. Confirm the fixture';
    description = 'Use a named fixture profile so the same jig, phone registration, and wheel datum are reused across the session.';
    warning = 'Select or save a fixture profile before wheel captures.';
  } else if (state.workflow === 'precision' && state.mode !== 'level' && !baseline.complete) {
    title = '3. Establish the baseline plane';
    description = 'Switch to Level mode and capture FL, FR, RL, and RR points before precision wheel measurements.';
    warning = `${baseline.completedSides}/4 baseline points are ready.`;
  } else if (!levelPrepared && state.mode !== 'level') {
    warning = 'Switch to Level mode and confirm the floor or car is level before alignment readings.';
  } else if (!state.calibrationMeta[state.mode]) {
    title = '2. Set a zero reference';
    description = guide.calibration;
    warning = 'This mode is not zeroed yet. Zero it on a known reference for better repeatability.';
  } else if (!state.orientationOk) {
    title = `3. Rotate to ${guide.orientation}`;
    description = `For ${MODE_LABELS[state.mode]}, ${guide.orientation.toLowerCase()} orientation gives a more repeatable placement.`;
    warning = `Current orientation is ${orientationLabel(state.screenOrientation)}. Rotate to ${guide.orientation}.`;
  } else if (state.workflow === 'precision' && !(precision.forward && precision.forward.count)) {
    title = '4. Capture forward readings';
    description = `Take repeated settled ${state.mode} readings for ${state.selectedSide} with the fixture in its normal orientation.`;
    warning = 'Forward precision capture set is empty.';
  } else if (state.workflow === 'precision' && precision.needsReverse && !(precision.reverse && precision.reverse.count)) {
    title = '5. Capture reversed readings';
    description = 'Flip the jig or phone in the reversible direction, then capture the same point again to estimate fixture bias.';
    warning = 'Reversed precision capture set is still missing.';
  } else if (!state.settled) {
    title = '4. Hold steady';
    description = 'The app is averaging recent samples. Keep the phone planted and avoid hand movement until stability turns to Settled.';
    warning = 'Movement or jitter is still above the settled threshold.';
  } else if (state.workflow === 'precision') {
    title = '6. Save the precision report';
    description = `Review repeatability, reversal bias, and baseline trust before saving ${state.mode} for ${state.selectedSide}.`;
    warning = `${precision.verdict} • Repeatability ${precision.repeatabilityScore}%`;
    tone = precision.verdict === 'Good enough for adjustment' ? 'good' : 'warn';
  } else {
    title = '5. Save the averaged reading';
    description = `Reading is settled. Lock it if needed, then save the averaged ${state.mode} value for ${state.selectedSide}.`;
    warning = 'Consumer-grade sensors are best for repeatable DIY checks, not certified rack alignment.';
    tone = 'good';
  }

  document.getElementById('workflow-step-title').textContent = title;
  document.getElementById('workflow-step-desc').textContent = description;
  document.getElementById('guide-placement').textContent = guide.placement;
  document.getElementById('guide-orientation').textContent = `Preferred: ${guide.orientation}`;
  document.getElementById('guide-side').textContent = `Target side: ${state.selectedSide}`;

  const warningEl = document.getElementById('warning-text');
  warningEl.textContent = warning;
  warningEl.className = `warning-text${tone ? ` ${tone}` : ''}`;
}

function refreshStatus() {
  const range = sampleRange();
  const stdDev = sampleStdDev();
  const calMeta = state.calibrationMeta[state.mode];
  const stabilityValue = !state.sampleBuffer.length ? 'Waiting' : (state.settled ? 'Settled' : 'Stabilizing');
  const stabilitySub = !state.sampleBuffer.length
    ? 'Need motion samples'
    : `${state.sampleBuffer.length}/${SAMPLE_WINDOW} samples • spread ${formatNumber(range)}°`;
  const orientationText = `${orientationLabel(state.screenOrientation)} ${state.orientationOk ? '✓' : '✕'}`;

  document.getElementById('chip-stability').textContent = stabilityValue;
  document.getElementById('chip-stability-sub').textContent = stabilitySub;
  document.getElementById('chip-confidence').textContent = `${state.confidence}%`;
  document.getElementById('chip-confidence-sub').textContent = `σ ${formatNumber(stdDev)}° • averaged live feed`;
  document.getElementById('chip-orientation').textContent = orientationText;
  document.getElementById('chip-orientation-sub').textContent = `Preferred for ${state.mode}: ${MODE_GUIDES[state.mode].orientation}`;
  document.getElementById('chip-calibration').textContent = calMeta ? formatSigned(calMeta.offset) : 'Not set';
  document.getElementById('chip-calibration-sub').textContent = calMeta
    ? `Zeroed ${formatTime(calMeta.time)} • ${orientationLabel(calMeta.orientation)}`
    : 'Zero this mode first';
}

function refreshWorkflowMode() {
  document.querySelectorAll('.workflow-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.workflow === state.workflow);
    tab.setAttribute('aria-selected', String(tab.dataset.workflow === state.workflow));
  });
  document.getElementById('precision-card').classList.toggle('hidden-panel', state.workflow !== 'precision');
}

function refreshGauge() {
  const avg = sampleAverage();
  updateNeedle(avg);
  drawBubble(avg);
  document.getElementById('gauge-mode-label').textContent = MODE_LABELS[state.mode];
  document.getElementById('avg-display').textContent = `Avg ${formatSigned(avg)} from ${state.sampleBuffer.length} sample${state.sampleBuffer.length === 1 ? '' : 's'}`;
  document.getElementById('confidence-label').textContent = state.settled ? `Confidence ${state.confidence}% • Settled` : `Confidence ${state.confidence}% • Live`;
}

function refreshCalibrationCard() {
  const meta = state.calibrationMeta[state.mode];
  const valueText = meta
    ? `Offset ${formatSigned(meta.offset)} for ${MODE_LABELS[state.mode]}`
    : 'None — tap Zero This Mode to calibrate';
  const historyText = meta
    ? `Last set ${formatTime(meta.time)} in ${orientationLabel(meta.orientation)}. Stored locally per mode.`
    : 'Saved locally per mode.';

  document.getElementById('cal-value-text').textContent = valueText;
  document.getElementById('cal-history-text').textContent = historyText;
  document.getElementById('btn-reset-cal').disabled = !meta;
}

function refreshPrecisionCard() {
  const baseline = baselineSummary();
  const summary = precisionSummary(state.mode, state.selectedSide);
  const fixture = activeFixture();

  document.getElementById('precision-step-title').textContent = state.mode === 'level'
    ? 'Precision baseline setup'
    : `Precision ${MODE_LABELS[state.mode]} session`;
  document.getElementById('precision-step-desc').textContent = state.mode === 'level'
    ? 'Capture around-the-car level points until the baseline plane is complete and stable.'
    : 'Use repeated settled captures with the same fixture profile, then add reversed captures if the jig supports it.';

  document.getElementById('device-profile-status').textContent = state.deviceProfile ? 'Ready' : 'Not set';
  document.getElementById('device-profile-sub').textContent = state.deviceProfile
    ? `${state.deviceProfile.label} • β ${formatSigned(state.deviceProfile.axisBias.beta)} • γ ${formatSigned(state.deviceProfile.axisBias.gamma)}`
    : 'Capture on a trusted flat or vertical reference.';
  document.getElementById('fixture-status').textContent = fixture ? fixture.name : 'Not set';
  document.getElementById('fixture-status-sub').textContent = fixture
    ? `${fixture.reversible ? 'Reversible' : 'Single orientation'} • ${fixture.notes || 'No notes'}`
    : 'Use a rigid, reversible jig if possible.';
  document.getElementById('baseline-status').textContent = baseline.label;
  document.getElementById('baseline-status-sub').textContent = baseline.complete
    ? `Front ${formatSigned(baseline.frontRearDelta || 0)} • Left ${formatSigned(baseline.leftRightDelta || 0)}`
    : `${baseline.completedSides}/4 points captured in Level mode.`;
  document.getElementById('precision-trust-status').textContent = summary.verdict;
  document.getElementById('precision-trust-sub').textContent = `Repeatability ${summary.repeatabilityScore}% • ${summary.needsReverse ? 'Reverse required' : 'Forward-only fixture'}`;

  const fixtureSelect = document.getElementById('fixture-select');
  const currentValue = state.precisionSession.fixtureId || '';
  fixtureSelect.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'No saved fixture yet';
  fixtureSelect.appendChild(placeholder);
  state.fixtureProfiles.forEach(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.name}${item.reversible ? ' • reversible' : ''}`;
    fixtureSelect.appendChild(option);
  });
  fixtureSelect.value = state.fixtureProfiles.some(item => item.id === currentValue) ? currentValue : '';
  document.getElementById('fixture-meta-text').textContent = fixture
    ? `${fixture.notes || 'No notes'} • Last used ${formatTime(fixture.lastUsedAt || fixture.createdAt)}`
    : 'Preferred jig: 3-point wheel-face contact, symmetric or reversible, hard registration to the phone.';

  SIDES.forEach(side => {
    const stats = baselineStatsForSide(side);
    const btn = document.getElementById(`baseline-btn-${side}`);
    const sub = document.getElementById(`baseline-btn-${side}-sub`);
    btn.classList.remove('ready', 'partial');
    if (stats?.count >= BASELINE_CAPTURE_TARGET) btn.classList.add('ready');
    else if (stats?.count) btn.classList.add('partial');
    sub.textContent = !stats
      ? '0 captures'
      : `${stats.count} cap • σ ${formatNumber(stats.stdDev)}°`;
  });

  document.getElementById('precision-target').textContent = `${MODE_LABELS[state.mode]} · ${state.selectedSide}`;
  document.getElementById('precision-target-sub').textContent = fixture
    ? `${fixture.name} • ${fixture.reversible ? 'capture both directions' : 'single orientation fixture'}`
    : 'Use the same jig and phone placement for every capture.';
  document.getElementById('precision-capture-counts').textContent = `${summary.forward?.count || 0} / ${summary.reverse?.count || 0}`;
  document.getElementById('precision-capture-sub').textContent = summary.needsReverse
    ? 'Forward count first, reversed count second.'
    : 'Forward count shown first; reverse is optional for this fixture.';
  document.getElementById('precision-repeatability-value').textContent = `${summary.repeatabilityScore}%`;
  document.getElementById('precision-repeatability-sub').textContent = summary.forward
    ? `Forward σ ${formatNumber(summary.forward.stdDev)}°${summary.reverse ? ` • Reverse σ ${formatNumber(summary.reverse.stdDev)}°` : ''}`
    : 'Settled spread and repeated agreement drive this score.';
  document.getElementById('precision-bias-value').textContent = summary.reversalBias === null ? 'Pending' : formatSigned(summary.reversalBias);
  document.getElementById('precision-bias-sub').textContent = summary.reversalBias === null
    ? 'Capture a reversed set to estimate mounting bias.'
    : `Baseline compensation ${formatSigned(summary.baselineCompensation)}`;
  document.getElementById('precision-baseline-plane').textContent = baseline.complete
    ? `${formatSigned(baseline.leftRightDelta || 0)} L-R`
    : `${baseline.completedSides}/4 ready`;
  document.getElementById('precision-baseline-plane-sub').textContent = baseline.complete
    ? `Front-Rear ${formatSigned(baseline.frontRearDelta || 0)} • ${baseline.label}`
    : 'Front/rear and left/right averages from Level mode.';
  document.getElementById('precision-final-value').textContent = Number.isFinite(summary.finalValue) ? formatSigned(summary.finalValue) : '—';
  document.getElementById('precision-final-sub').textContent = `${summary.verdict}${Number.isFinite(summary.reversalCorrectedValue) ? ` • corrected ${formatSigned(summary.reversalCorrectedValue)}` : ''}`;
  document.getElementById('btn-save-precision').disabled = !summary.readyToSave || !Number.isFinite(summary.finalValue);
}

function refreshLockButton() {
  const btn = document.getElementById('btn-lock');
  btn.textContent = state.locked ? 'Resume Live' : 'Lock';
  btn.className = `btn btn-small ${state.locked ? 'btn-warning' : 'btn-surface'}`;
  btn.title = state.locked ? 'Resume live reading' : 'Lock reading';
  const saveBtn = document.getElementById('btn-save');
  saveBtn.textContent = state.workflow === 'precision' ? 'Save Precision' : 'Save Avg';
  if (state.workflow === 'precision') {
    const summary = precisionSummary(state.mode, state.selectedSide);
    saveBtn.disabled = !summary.readyToSave || !Number.isFinite(summary.finalValue);
  } else {
    saveBtn.disabled = !state.settled;
  }
}

function refreshSavedReadings() {
  document.querySelectorAll('.side-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.side === state.selectedSide);
    button.setAttribute('aria-selected', String(button.dataset.side === state.selectedSide));
  });

  const current = measurementFor(state.mode, state.selectedSide);
  document.getElementById('saved-side-title').textContent = `${MODE_LABELS[state.mode]} · ${state.selectedSide}`;
  document.getElementById('saved-side-value').textContent = current ? formatSigned(current.value) : 'No saved reading';
  document.getElementById('saved-side-note').textContent = current
    ? [
        `Saved ${formatTime(current.time)}`,
        current.workflow === 'precision' ? `precision ${current.repeatabilityScore || 0}%` : `${current.confidence}% confidence`,
        current.workflow === 'precision' && current.trustVerdict ? current.trustVerdict : `${current.samples} samples`,
      ].join(' • ')
    : `Hold the phone steady until it settles, then tap ${state.workflow === 'precision' ? 'Save Precision' : 'Save Avg'}.`;

  const frontDelta = deltaFor(state.mode, 'FL', 'FR');
  const rearDelta = deltaFor(state.mode, 'RL', 'RR');
  document.getElementById('front-delta').textContent = frontDelta === null ? '—' : formatSigned(frontDelta);
  document.getElementById('front-delta-note').textContent = frontDelta === null ? 'Save both front sides for this mode.' : 'A negative delta means FL is smaller than FR.';
  document.getElementById('rear-delta').textContent = rearDelta === null ? '—' : formatSigned(rearDelta);
  document.getElementById('rear-delta-note').textContent = rearDelta === null ? 'Save both rear sides for this mode.' : 'A negative delta means RL is smaller than RR.';

  const list = document.getElementById('saved-list');
  const readings = SIDES
    .map(side => measurementFor(state.mode, side))
    .filter(Boolean)
    .sort((a, b) => SIDES.indexOf(a.side) - SIDES.indexOf(b.side));

  list.textContent = '';

  if (!readings.length) {
    list.appendChild(buildElement('div', 'saved-item empty', 'No saved readings yet for this mode.'));
    return;
  }

  readings.forEach(item => {
    const row = buildElement('div', 'saved-item');
    const metaWrap = document.createElement('div');
    const label = buildElement('div', 'saved-label', item.side);
    const metaParts = [`Saved ${formatTime(item.time)}`];
    if (item.workflow === 'precision') {
      metaParts.push(`${item.repeatabilityScore || 0}% repeatability`);
      if (item.trustVerdict) metaParts.push(item.trustVerdict);
      if (item.reversalBias !== null && item.reversalBias !== undefined) metaParts.push(`bias ${formatSigned(item.reversalBias)}`);
    } else {
      metaParts.push(`${item.confidence}% confidence`);
      metaParts.push(`${item.samples} samples`);
    }
    const meta = buildElement('div', 'saved-meta', metaParts.join(' • '));
    const value = buildElement('strong', 'saved-value', formatSigned(item.value));

    metaWrap.appendChild(label);
    metaWrap.appendChild(meta);
    row.appendChild(metaWrap);
    row.appendChild(value);
    list.appendChild(row);
  });
}

function refreshAdvanced() {
  document.getElementById('raw-alpha').textContent = `${formatNumber(state.alpha)}°`;
  document.getElementById('raw-beta').textContent = `${formatNumber(state.beta)}°`;
  document.getElementById('raw-gamma').textContent = `${formatNumber(state.gamma)}°`;
  document.getElementById('sample-spread').textContent = `${formatNumber(sampleRange())}° range • ${formatNumber(sampleStdDev())}° σ`;

  const list = document.getElementById('mode-cal-list');
  list.textContent = '';
  MODES.forEach(mode => {
    const meta = state.calibrationMeta[mode];
    const item = buildElement('div', 'advanced-item');
    const label = buildElement('span', 'advanced-label', MODE_LABELS[mode]);
    const value = buildElement('strong', 'advanced-value', meta ? formatSigned(meta.offset) : 'Not set');
    const detail = buildElement('span', 'saved-meta', meta ? `Saved ${formatTime(meta.time)} • ${orientationLabel(meta.orientation)}` : 'No stored zero yet.');

    item.appendChild(label);
    item.appendChild(value);
    item.appendChild(detail);
    list.appendChild(item);
  });
}

function refreshUI() {
  state.screenOrientation = currentOrientation();
  state.orientationOk = state.screenOrientation === preferredOrientation();
  refreshWorkflowMode();
  refreshGuide();
  refreshGauge();
  refreshStatus();
  refreshCalibrationCard();
  refreshPrecisionCard();
  refreshLockButton();
  refreshSavedReadings();
  refreshAdvanced();
  refreshAriaState();
}

function refreshLiveUI() {
  state.screenOrientation = currentOrientation();
  state.orientationOk = state.screenOrientation === preferredOrientation();
  refreshGuide();
  refreshGauge();
  refreshStatus();
  refreshLockButton();
  refreshAdvanced();
  refreshAriaState();
}

function scheduleLiveRefresh() {
  if (state.liveRefreshScheduled) return;
  state.liveRefreshScheduled = true;
  window.requestAnimationFrame(() => {
    state.liveRefreshScheduled = false;
    refreshLiveUI();
  });
}

function refreshAriaState() {
  document.querySelectorAll('.mode-tab').forEach(tab => {
    const isSelected = tab.dataset.mode === state.mode;
    tab.setAttribute('aria-selected', String(isSelected));
  });
}

function setupEventHandlers() {
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const { action, arg } = trigger.dataset;
    if (!action) return;
    const handlers = {
      startApp: () => startApp(),
      showInstructions: () => showInstructions(),
      toggleLock: () => toggleLock(),
      setWorkflow: () => setWorkflow(arg),
      setMode: () => setMode(arg),
      createOrUpdateFixture: () => createOrUpdateFixture(),
      captureDeviceCalibration: () => captureDeviceCalibration(),
      resetPrecisionSession: () => resetPrecisionSession(),
      resetDeviceCalibration: () => resetDeviceCalibration(),
      captureBaselinePoint: () => captureBaselinePoint(arg),
      capturePrecisionReading: () => capturePrecisionReading(arg),
      savePrecisionMeasurement: () => savePrecisionMeasurement(),
      calibrate: () => calibrate(),
      saveMeasurement: () => saveMeasurement(),
      resetCalibration: () => resetCalibration(),
      selectSide: () => selectSide(arg),
      backFromInstructions: () => backFromInstructions(),
    };
    const handler = handlers[action];
    if (handler) handler();
  });

  const fixtureSelect = document.getElementById('fixture-select');
  fixtureSelect.addEventListener('change', event => {
    selectFixture(event.target.value);
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(error => {
      console.warn('Unable to register service worker.', error);
    });
  });
}

(function init() {
  loadState();
  hideSensorBanner();
  initGaugeSVG();
  setupEventHandlers();
  registerServiceWorker();
  window.addEventListener('resize', refreshUI);
  window.addEventListener('orientationchange', () => {
    resetLiveAveraging();
    refreshUI();
  });
  refreshUI();
})();
