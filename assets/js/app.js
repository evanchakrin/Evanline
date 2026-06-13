import {
  average,
  buildArcPath,
  captureSeriesStats,
  clampAngle as clampAngleInRange,
  computeSampleQuality,
  polarPoint,
  standardDeviation,
} from './domain.js';
import {
  PRECISION_CONSTANTS,
  baselineSummary as computeBaselineSummary,
  baselineCompensationForSide as computeBaselineCompensation,
  computeGuideState,
  precisionSummary as computePrecisionSummary,
} from './precision.js';

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
const DIRECTION_DEADBAND_DEG = 0.15;
const BUBBLE_LEVEL_THRESHOLD_DEG = 0.5;
const BUBBLE_WARN_THRESHOLD_DEG = 3;
const NEEDLE_GOOD_THRESHOLD_DEG = 1.5;
const NEEDLE_WARN_THRESHOLD_DEG = 3;
const SMOOTHING_ALPHA = 0.22;
const SAMPLE_WINDOW = 12;
const MIN_SAMPLE_COUNT = 6;
const SETTLED_RANGE = 0.18;
const SETTLED_STDDEV = 0.08;
const SETTLED_HOLD_MS = 900;
const PRECISION_CAPTURE_TARGET = 3;
const BASELINE_CAPTURE_TARGET = 2;

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
  lastSaveConfirmation: null,
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

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} not found in DOM. Verify the ID is correct and the element exists.`);
  return node;
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
    localStorage.removeItem('evanline-state-v2');
  } catch (error) {
    console.warn('Unable to migrate legacy Evanline state to v3 storage.', error);
  }
  return parsed;
}

function clampAngle(angle) {
  return clampAngleInRange(angle, GAUGE_RANGE);
}

function initGaugeSVG() {
  const bgArc = el('gauge-bg-arc');
  const colArc = el('gauge-arc');
  const ticks = el('gauge-ticks');
  const labels = el('gauge-tick-labels');
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
  const canvas = el('bubble-canvas');
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
  const isLevel = Math.abs(angle) < BUBBLE_LEVEL_THRESHOLD_DEG;
  const bubbleColour = isLevel ? '#3fb950' : (Math.abs(angle) < BUBBLE_WARN_THRESHOLD_DEG ? '#d29922' : '#f85149');
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
  const needle = el('gauge-needle');
  const display = el('angle-display');
  const badge = el('aligned-badge');
  const svgText = el('svg-aligned-text');
  const abs = Math.abs(angleDeg);

  needle.setAttribute('transform', `rotate(${rotDeg},${CX},${CY})`);
  display.textContent = formatNumber(abs);

  if (state.aligned) {
    display.style.color = 'var(--green)';
    badge.classList.add('visible');
    badge.setAttribute('aria-hidden', 'false');
    svgText.setAttribute('opacity', '1');
    svgText.textContent = '● Settled & aligned';
  } else {
    badge.classList.remove('visible');
    badge.setAttribute('aria-hidden', 'true');
    svgText.setAttribute('opacity', '0');
    svgText.textContent = '';
    if (abs < NEEDLE_GOOD_THRESHOLD_DEG) display.style.color = 'var(--text)';
    else if (abs < NEEDLE_WARN_THRESHOLD_DEG) display.style.color = 'var(--yellow)';
    else display.style.color = 'var(--red)';
  }

  el('angle-direction').textContent = directionLabel(angleDeg);
}

function directionLabel(angleDeg) {
  if (state.mode === 'camber') {
    return angleDeg > DIRECTION_DEADBAND_DEG ? '▲ Positive Camber' : angleDeg < -DIRECTION_DEADBAND_DEG ? '▼ Negative Camber' : '— Zero Camber';
  }
  if (state.mode === 'toe') {
    return angleDeg > DIRECTION_DEADBAND_DEG ? '→ Toe Out' : angleDeg < -DIRECTION_DEADBAND_DEG ? '← Toe In' : '— Neutral';
  }
  if (state.mode === 'level') {
    return angleDeg > DIRECTION_DEADBAND_DEG ? '↗ Tilts Right' : angleDeg < -DIRECTION_DEADBAND_DEG ? '↖ Tilts Left' : '— Level';
  }
  return angleDeg > DIRECTION_DEADBAND_DEG ? '↑ Nose Up' : angleDeg < -DIRECTION_DEADBAND_DEG ? '↓ Nose Down' : '— Flat';
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
  return computeBaselineSummary(state.precisionSession.baselinePoints, SIDES, PRECISION_CONSTANTS);
}

function baselineCompensationForSide(side, mode, summary = baselineSummary()) {
  return computeBaselineCompensation(side, mode, summary);
}

function precisionSummary(mode = state.mode, side = state.selectedSide) {
  return computePrecisionSummary({
    mode,
    side,
    captures: state.precisionSession.captures,
    baseline: baselineSummary(),
    fixture: activeFixture(),
    constants: PRECISION_CONSTANTS,
  });
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

function setSaveConfirmation(text) {
  state.lastSaveConfirmation = text;
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

function detachSensorListener() {
  if (!state.sensorListenerAttached) return;
  window.removeEventListener('deviceorientation', onOrientation, true);
  state.sensorListenerAttached = false;
}

function pauseSensors() {
  state.locked = true;
  detachSensorListener();
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
          state.locked = false;
          resetLiveAveraging();
          attachSensorListener();
          state.sensorsAvailable = true;
          hideSensorBanner();
        } else {
          state.sensorsAvailable = false;
          showSensorBanner();
        }
        refreshUI();
        if (callback) callback(response === 'granted');
      })
      .catch(() => {
        state.sensorsAvailable = false;
        showSensorBanner();
        refreshUI();
        if (callback) callback(false);
      });
  } else if (typeof DeviceOrientationEvent !== 'undefined') {
    state.locked = false;
    resetLiveAveraging();
    attachSensorListener();
    state.sensorsAvailable = true;
    hideSensorBanner();
    refreshUI();
    if (callback) callback(true);
  } else {
    state.sensorsAvailable = false;
    showSensorBanner();
    refreshUI();
    if (callback) callback(false);
  }
}

function showSensorBanner() {
  el('sensor-banner').classList.remove('hidden');
}

function hideSensorBanner() {
  el('sensor-banner').classList.add('hidden');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(screen => {
    const hidden = screen.id !== id;
    screen.setAttribute('aria-hidden', String(hidden));
    screen.inert = hidden;
    if (screen.hideTimer) {
      window.clearTimeout(screen.hideTimer);
      screen.hideTimer = 0;
    }
    if (hidden) {
      screen.classList.add('hidden');
      screen.hideTimer = window.setTimeout(() => {
        screen.classList.add('hidden-done');
        screen.hideTimer = 0;
      }, 350);
    } else {
      screen.classList.remove('hidden-done');
      window.requestAnimationFrame(() => {
        screen.classList.remove('hidden');
      });
    }
  });
}

function syncScreenVisibility() {
  const visibleScreen = document.querySelector('.screen:not(.hidden)')?.id || 'screen-welcome';
  showScreen(visibleScreen);
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

function retrySensors() {
  requestSensors(ok => {
    if (ok) {
      setNotice('Measurement started. Keep the phone planted until the reading settles.', 'good');
    } else {
      setNotice('Sensor access is still blocked. Confirm Safari, HTTPS or localhost, and motion permission settings.', 'warn');
    }
    refreshUI();
  });
}

function showInstructions() {
  state.prevScreen = document.querySelector('.screen:not(.hidden)')?.id || 'screen-welcome';
  if (state.sensorListenerAttached) {
    pauseSensors();
  }
  showScreen('screen-instructions');
  refreshUI();
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
  // Side selection affects the guide step, precision panel, lock button label, and saved-readings list.
  refreshGuide();
  refreshReadiness();
  refreshPrecisionCard();
  refreshLockButton();
  refreshSavedReadings();
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
  const dialog = el('fixture-dialog');
  const nameInput = el('fixture-form-name');
  const notesInput = el('fixture-form-notes');
  const reversibleInput = el('fixture-form-reversible');
  nameInput.value = current?.name || `Fixture ${state.fixtureProfiles.length + 1}`;
  notesInput.value = current?.notes || '3-point wheel-face jig';
  reversibleInput.checked = !!current?.reversible;
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    // Fallback for browsers without <dialog> support.
    dialog.setAttribute('open', '');
  }
  // Focus the name field once the dialog is visible.
  requestAnimationFrame(() => nameInput.focus());
}

function handleFixtureFormSubmit(event) {
  event.preventDefault();
  const dialog = el('fixture-dialog');
  const name = el('fixture-form-name').value.trim();
  if (!name) {
    el('fixture-form-name').focus();
    return;
  }
  const notes = el('fixture-form-notes').value.trim();
  const reversible = el('fixture-form-reversible').checked;
  const current = activeFixture();
  const id = current?.id || `fixture-${Date.now()}`;
  const profile = {
    id,
    name,
    reversible,
    notes,
    createdAt: current?.createdAt || new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  state.fixtureProfiles = [...state.fixtureProfiles.filter(item => item.id !== id), profile].slice(-MAX_FIXTURE_PROFILES);
  state.precisionSession.fixtureId = id;
  saveState();
  setNotice(`Fixture profile "${profile.name}" saved.`, 'good');
  dialog.close('save');
  refreshUI();
}

function closeFixtureDialog() {
  const dialog = el('fixture-dialog');
  if (dialog.open) dialog.close('cancel');
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
  if (!state.sensorListenerAttached) {
    setNotice('Tap Start Measuring before zeroing this mode.', 'warn');
    refreshUI();
    return;
  }
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
  if (state.sensorListenerAttached) {
    pauseSensors();
    setNotice('Measurement paused. Sensor telemetry is stopped until you tap Start Measuring.', 'good');
    refreshUI();
    return;
  }
  requestSensors(ok => {
    setNotice(ok ? 'Measurement started. Hold steady until the reading settles.' : 'Sensor access is blocked. Check Safari motion permission settings.', ok ? 'good' : 'warn');
    refreshUI();
  });
}

function guideStepNumber(title) {
  const match = /^(\d+)/.exec(title);
  return match ? Number(match[1]) : 1;
}

function guideActionState() {
  const guide = MODE_GUIDES[state.mode];
  const precision = precisionSummary(state.mode, state.selectedSide);
  const baseline = precision.baseline;
  if (!state.sensorsAvailable) {
    return { label: 'Retry sensor access', action: 'retrySensors', reason: 'Motion permission is required before measuring.' };
  }
  if (!state.sensorListenerAttached) {
    return { label: 'Start Measuring', action: 'startMeasuring', reason: 'Sensor telemetry is paused until you start a measurement.' };
  }
  if (state.workflow === 'precision' && !state.deviceProfile) {
    return {
      label: state.settled ? 'Capture device reference' : 'Hold steady for device ref',
      action: 'captureDeviceCalibration',
      reason: state.settled ? 'Ready to capture a trusted device bias.' : 'Device reference needs a settled reading first.',
    };
  }
  if (state.workflow === 'precision' && !activeFixture()) {
    return { label: 'Save or select fixture', action: 'createOrUpdateFixture', reason: 'Precision captures need a named fixture profile.' };
  }
  if (state.workflow === 'precision' && state.mode !== 'level' && !baseline.complete) {
    return { label: 'Switch to Level baseline', action: 'setModeLevel', reason: `${baseline.completedSides}/4 baseline points are ready.` };
  }
  if (!(state.calibrationMeta.level || hasSavedLevelReading()) && state.mode !== 'level') {
    return { label: 'Switch to Level first', action: 'setModeLevel', reason: 'Level mode prepares a trustworthy baseline.' };
  }
  if (!state.calibrationMeta[state.mode]) {
    return { label: 'Zero this mode', action: 'calibrate', reason: `${MODE_LABELS[state.mode]} is not zeroed yet.` };
  }
  if (!state.orientationOk) {
    return { label: `Rotate to ${guide.orientation}`, action: 'none', reason: `Current orientation is ${orientationLabel(state.screenOrientation)}.` };
  }
  if (state.workflow === 'precision' && !(precision.forward && precision.forward.count)) {
    return {
      label: state.settled ? 'Capture forward' : 'Hold steady for forward',
      action: 'captureForward',
      reason: state.settled ? 'Forward capture set is ready for a sample.' : 'Forward capture needs a settled reading.',
    };
  }
  if (state.workflow === 'precision' && precision.needsReverse && !(precision.reverse && precision.reverse.count)) {
    return {
      label: state.settled ? 'Capture reversed' : 'Hold steady for reverse',
      action: 'captureReverse',
      reason: state.settled ? 'Reversed capture set is ready for a sample.' : 'Reversed capture needs a settled reading.',
    };
  }
  if (!state.settled) {
    return { label: 'Hold steady', action: 'none', reason: 'Movement or jitter is still above the settled threshold.' };
  }
  return {
    label: state.workflow === 'precision' ? 'Save precision report' : 'Save averaged reading',
    action: 'saveMeasurement',
    reason: state.workflow === 'precision' ? precisionSaveReason(precision) : 'Settled reading is ready to save.',
  };
}

function performGuideAction() {
  const { action } = guideActionState();
  const handlers = {
    retrySensors: () => retrySensors(),
    startMeasuring: () => toggleLock(),
    captureDeviceCalibration: () => captureDeviceCalibration(),
    createOrUpdateFixture: () => createOrUpdateFixture(),
    setModeLevel: () => setMode('level'),
    calibrate: () => calibrate(),
    captureForward: () => capturePrecisionReading('forward'),
    captureReverse: () => capturePrecisionReading('reverse'),
    saveMeasurement: () => saveMeasurement(),
  };
  if (handlers[action]) {
    handlers[action]();
  } else {
    refreshUI();
  }
}

function precisionSaveReason(summary = precisionSummary(state.mode, state.selectedSide)) {
  if (!Number.isFinite(summary.finalValue)) return 'Capture repeated readings before saving.';
  if (!summary.forward || summary.forward.count < PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_READY) {
    return `Need ${PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_READY} forward captures.`;
  }
  if (summary.needsReverse && (!summary.reverse || summary.reverse.count < PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_READY)) {
    return `Need ${PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_READY} reversed captures.`;
  }
  return `${summary.verdict} • ${summary.repeatabilityScore}% repeatability.`;
}

function captureBaselinePoint(side) {
  if (!state.sensorListenerAttached) {
    setNotice('Tap Start Measuring before capturing a baseline point.', 'warn');
    refreshUI();
    return;
  }
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
  if (!state.sensorListenerAttached) {
    setNotice('Tap Start Measuring before capturing precision readings.', 'warn');
    refreshUI();
    return;
  }
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
  pauseSensors();
  setSaveConfirmation(`Saved ${MODE_LABELS[state.mode]} · ${state.selectedSide} at ${formatSigned(measurement.value)} with ${measurement.confidence}% confidence.`);
  setNotice(`Saved averaged ${state.mode} reading for ${state.selectedSide}. Measurement paused.`, 'good');
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
  pauseSensors();
  setSaveConfirmation(`Saved precision ${MODE_LABELS[state.mode]} · ${state.selectedSide} at ${formatSigned(measurement.value)} • ${measurement.trustVerdict}.`);
  setNotice(`Saved precision ${state.mode} reading for ${state.selectedSide}. Measurement paused.`, 'good');
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
  const precision = precisionSummary(state.mode, state.selectedSide);
  const { title, description, warning, tone } = computeGuideState({
    sensorsAvailable: state.sensorsAvailable,
    notice: activeNotice(),
    workflow: state.workflow,
    mode: state.mode,
    selectedSide: state.selectedSide,
    deviceProfileSet: !!state.deviceProfile,
    fixtureSelected: !!activeFixture(),
    calibrationSet: !!state.calibrationMeta[state.mode],
    levelPrepared: !!(state.calibrationMeta.level || hasSavedLevelReading()),
    orientationOk: state.orientationOk,
    screenOrientationLabel: orientationLabel(state.screenOrientation),
    preferredOrientationLabel: guide.orientation,
    settled: state.settled,
    baseline: precision.baseline,
    precision,
    modeLabel: MODE_LABELS[state.mode],
    guide,
  });

  el('workflow-step-title').textContent = title;
  el('workflow-step-desc').textContent = description;
  el('guide-placement').textContent = guide.placement;
  el('guide-orientation').textContent = `Preferred: ${guide.orientation}`;
  el('guide-side').textContent = `Target side: ${state.selectedSide}`;

  const warningEl = el('warning-text');
  warningEl.textContent = warning;
  warningEl.className = `warning-text${tone ? ` ${tone}` : ''}`;

  const step = guideStepNumber(title);
  document.querySelectorAll('[data-guide-dot]').forEach(dot => {
    const value = Number(dot.dataset.guideDot);
    dot.classList.toggle('done', value < step);
    dot.classList.toggle('active', value === step);
  });

  const actionState = guideActionState();
  const guideAction = el('guide-action');
  guideAction.textContent = actionState.label;
  guideAction.title = actionState.reason;
  guideAction.disabled = actionState.action === 'none';
}

function refreshReadiness() {
  const actionState = guideActionState();
  const summary = precisionSummary(state.mode, state.selectedSide);
  const saveReady = state.workflow === 'precision'
    ? summary.readyToSave && Number.isFinite(summary.finalValue)
    : state.settled;
  const saveReason = state.workflow === 'precision'
    ? precisionSaveReason(summary)
    : (state.settled ? 'Settled average is ready.' : `${state.sampleBuffer.length}/${SAMPLE_WINDOW} samples • hold steady.`);
  const liveState = !state.sensorListenerAttached
    ? 'Paused'
    : (!state.sampleBuffer.length ? 'Waiting' : (state.settled ? 'Settled' : 'Settling'));

  el('readiness-live').textContent = liveState;
  el('readiness-live-sub').textContent = !state.sensorListenerAttached
    ? 'Tap Start Measuring'
    : `${state.sampleBuffer.length}/${SAMPLE_WINDOW} samples`;
  el('readiness-save').textContent = saveReady ? 'Ready' : 'Blocked';
  el('readiness-save-sub').textContent = saveReason;
  el('readiness-next').textContent = actionState.label;
  el('readiness-next-sub').textContent = actionState.reason;
}

function refreshStatus() {
  const range = sampleRange();
  const stdDev = sampleStdDev();
  const calMeta = state.calibrationMeta[state.mode];
  const stabilityValue = !state.sensorListenerAttached
    ? 'Paused'
    : (!state.sampleBuffer.length ? 'Waiting' : (state.settled ? 'Settled' : 'Stabilizing'));
  const stabilitySub = !state.sensorListenerAttached
    ? 'Telemetry stopped'
    : (!state.sampleBuffer.length
        ? 'Need motion samples'
        : `${state.sampleBuffer.length}/${SAMPLE_WINDOW} samples • spread ${formatNumber(range)}°`);
  const orientationText = `${orientationLabel(state.screenOrientation)} ${state.orientationOk ? '✓' : '✕'}`;

  el('chip-stability').textContent = stabilityValue;
  el('chip-stability-sub').textContent = stabilitySub;
  el('chip-confidence').textContent = `${state.confidence}%`;
  el('chip-confidence-sub').textContent = state.sensorListenerAttached
    ? `σ ${formatNumber(stdDev)}° • averaged live feed`
    : 'Start measuring to refresh confidence';
  el('chip-orientation').textContent = orientationText;
  el('chip-orientation-sub').textContent = `Preferred for ${state.mode}: ${MODE_GUIDES[state.mode].orientation}`;
  el('chip-calibration').textContent = calMeta ? formatSigned(calMeta.offset) : 'Not set';
  el('chip-calibration-sub').textContent = calMeta
    ? `Zeroed ${formatTime(calMeta.time)} • ${orientationLabel(calMeta.orientation)}`
    : 'Zero this mode first';
}

function refreshWorkflowMode() {
  document.querySelectorAll('.workflow-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.workflow === state.workflow);
    tab.setAttribute('aria-selected', String(tab.dataset.workflow === state.workflow));
  });
  el('precision-card').classList.toggle('hidden-panel', state.workflow !== 'precision');
}

function refreshGauge() {
  const avg = sampleAverage();
  updateNeedle(avg);
  drawBubble(avg);
  el('gauge-mode-label').textContent = MODE_LABELS[state.mode];
  el('avg-display').textContent = `Avg ${formatSigned(avg)} from ${state.sampleBuffer.length} sample${state.sampleBuffer.length === 1 ? '' : 's'}`;
  el('confidence-label').textContent = !state.sensorListenerAttached
    ? `Confidence ${state.confidence}% • Paused`
    : (state.settled ? `Confidence ${state.confidence}% • Settled` : `Confidence ${state.confidence}% • Live`);
}

function refreshCalibrationCard() {
  const meta = state.calibrationMeta[state.mode];
  const valueText = meta
    ? `Offset ${formatSigned(meta.offset)} for ${MODE_LABELS[state.mode]}`
    : 'None — tap Zero This Mode to calibrate';
  const historyText = meta
    ? `Last set ${formatTime(meta.time)} in ${orientationLabel(meta.orientation)}. Stored locally per mode.`
    : 'Saved locally per mode.';

  el('cal-value-text').textContent = valueText;
  el('cal-history-text').textContent = historyText;
  el('btn-reset-cal').disabled = !meta;
}

function refreshPrecisionCard() {
  const baseline = baselineSummary();
  const summary = precisionSummary(state.mode, state.selectedSide);
  const fixture = activeFixture();

  el('precision-step-title').textContent = state.mode === 'level'
    ? 'Precision baseline setup'
    : `Precision ${MODE_LABELS[state.mode]} session`;
  el('precision-step-desc').textContent = state.mode === 'level'
    ? 'Capture around-the-car level points until the baseline plane is complete and stable.'
    : 'Use repeated settled captures with the same fixture profile, then add reversed captures if the jig supports it.';

  el('device-profile-status').textContent = state.deviceProfile ? 'Ready' : 'Not set';
  el('device-profile-sub').textContent = state.deviceProfile
    ? `${state.deviceProfile.label} • β ${formatSigned(state.deviceProfile.axisBias.beta)} • γ ${formatSigned(state.deviceProfile.axisBias.gamma)}`
    : 'Capture on a trusted flat or vertical reference.';
  el('fixture-status').textContent = fixture ? fixture.name : 'Not set';
  el('fixture-status-sub').textContent = fixture
    ? `${fixture.reversible ? 'Reversible' : 'Single orientation'} • ${fixture.notes || 'No notes'}`
    : 'Use a rigid, reversible jig if possible.';
  el('baseline-status').textContent = baseline.label;
  el('baseline-status-sub').textContent = baseline.complete
    ? `Front ${formatSigned(baseline.frontRearDelta || 0)} • Left ${formatSigned(baseline.leftRightDelta || 0)}`
    : `${baseline.completedSides}/4 points captured in Level mode.`;
  el('precision-trust-status').textContent = summary.verdict;
  el('precision-trust-sub').textContent = `Repeatability ${summary.repeatabilityScore}% • ${summary.needsReverse ? 'Reverse required' : 'Forward-only fixture'}`;
  el('precision-summary-device').textContent = state.deviceProfile ? 'Device OK' : 'Device missing';
  el('precision-summary-fixture').textContent = fixture ? 'Fixture OK' : 'Fixture missing';
  el('precision-summary-baseline').textContent = baseline.complete ? `Baseline ${baseline.label}` : `Baseline ${baseline.completedSides}/4`;
  el('precision-summary-trust').textContent = `${summary.repeatabilityScore}% trust`;

  const deviceCapture = el('btn-capture-device');
  deviceCapture.disabled = !state.sensorListenerAttached || !state.settled;
  deviceCapture.title = !state.sensorListenerAttached
    ? 'Tap Start Measuring before capturing device bias.'
    : (state.settled
    ? 'Capture the current settled sensor bias as the device reference.'
    : 'Hold the phone steady until stability turns to Settled before capturing device bias.');

  const fixtureSelect = el('fixture-select');
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
  el('fixture-meta-text').textContent = fixture
    ? `${fixture.notes || 'No notes'} • Last used ${formatTime(fixture.lastUsedAt || fixture.createdAt)}`
    : 'Preferred jig: 3-point wheel-face contact, symmetric or reversible, hard registration to the phone.';

  SIDES.forEach(side => {
    const stats = baselineStatsForSide(side);
    const btn = el(`baseline-btn-${side}`);
    const sub = el(`baseline-btn-${side}-sub`);
    btn.classList.remove('ready', 'partial');
    if (stats?.count >= BASELINE_CAPTURE_TARGET) btn.classList.add('ready');
    else if (stats?.count) btn.classList.add('partial');
    sub.textContent = !stats
      ? '0 captures'
      : `${stats.count} cap • σ ${formatNumber(stats.stdDev)}°`;
    btn.disabled = state.workflow !== 'precision' || state.mode !== 'level' || !state.sensorListenerAttached || !state.settled;
    btn.title = state.mode === 'level'
      ? (!state.sensorListenerAttached
          ? 'Tap Start Measuring before capturing baseline points.'
          : (state.settled ? `Capture baseline point for ${side}.` : 'Hold steady in Level mode before capturing.'))
      : 'Switch to Level mode to capture baseline points.';
  });

  el('precision-target').textContent = `${MODE_LABELS[state.mode]} · ${state.selectedSide}`;
  el('precision-target-sub').textContent = fixture
    ? `${fixture.name} • ${fixture.reversible ? 'capture both directions' : 'single orientation fixture'}`
    : 'Use the same jig and phone placement for every capture.';
  el('precision-capture-counts').textContent = `${summary.forward?.count || 0} / ${summary.reverse?.count || 0}`;
  el('precision-capture-sub').textContent = summary.needsReverse
    ? 'Forward count first, reversed count second.'
    : 'Forward count shown first; reverse is optional for this fixture.';
  el('precision-repeatability-value').textContent = `${summary.repeatabilityScore}%`;
  el('precision-repeatability-sub').textContent = summary.forward
    ? `Forward σ ${formatNumber(summary.forward.stdDev)}°${summary.reverse ? ` • Reverse σ ${formatNumber(summary.reverse.stdDev)}°` : ''}`
    : 'Settled spread and repeated agreement drive this score.';
  el('precision-bias-value').textContent = summary.reversalBias === null ? 'Pending' : formatSigned(summary.reversalBias);
  el('precision-bias-sub').textContent = summary.reversalBias === null
    ? 'Capture a reversed set to estimate mounting bias.'
    : `Baseline compensation ${formatSigned(summary.baselineCompensation)}`;
  el('precision-baseline-plane').textContent = baseline.complete
    ? `${formatSigned(baseline.leftRightDelta || 0)} L-R`
    : `${baseline.completedSides}/4 ready`;
  el('precision-baseline-plane-sub').textContent = baseline.complete
    ? `Front-Rear ${formatSigned(baseline.frontRearDelta || 0)} • ${baseline.label}`
    : 'Front/rear and left/right averages from Level mode.';
  el('precision-final-value').textContent = Number.isFinite(summary.finalValue) ? formatSigned(summary.finalValue) : '—';
  el('precision-final-sub').textContent = `${summary.verdict}${Number.isFinite(summary.reversalCorrectedValue) ? ` • corrected ${formatSigned(summary.reversalCorrectedValue)}` : ''}`;
  const captureBlockedReason = !fixture
    ? 'Select or save a fixture profile before capturing.'
    : (!state.sensorListenerAttached
        ? 'Tap Start Measuring before capturing precision readings.'
        : (!state.settled
        ? 'Hold steady until stability turns to Settled before capturing.'
        : (state.mode !== 'level' && !baseline.complete
            ? 'Capture all four Level baseline points before wheel captures.'
            : 'Capture a settled reading for the selected side.')));
  const captureBlocked = !fixture || !state.sensorListenerAttached || !state.settled || (state.mode !== 'level' && !baseline.complete);
  el('btn-capture-forward').disabled = captureBlocked;
  el('btn-capture-reverse').disabled = captureBlocked;
  el('btn-capture-forward').title = captureBlockedReason;
  el('btn-capture-reverse').title = captureBlockedReason;
  el('btn-save-precision').disabled = !summary.readyToSave || !Number.isFinite(summary.finalValue);
  el('btn-save-precision').title = precisionSaveReason(summary);
  el('precision-control-hint').textContent = captureBlocked ? `Capture blocked: ${captureBlockedReason}` : precisionSaveReason(summary);
}

function refreshLockButton() {
  const btn = el('btn-lock');
  btn.textContent = state.sensorListenerAttached ? 'Pause' : 'Start Measuring';
  btn.className = `btn btn-small ${state.sensorListenerAttached ? 'btn-warning' : 'btn-surface'}`;
  btn.title = state.sensorListenerAttached ? 'Stop sensor telemetry' : 'Start sensor telemetry for a measurement';
  const saveBtn = el('btn-save');
  saveBtn.textContent = state.workflow === 'precision' ? 'Save Precision' : 'Save Avg';
  if (state.workflow === 'precision') {
    const summary = precisionSummary(state.mode, state.selectedSide);
    saveBtn.disabled = !summary.readyToSave || !Number.isFinite(summary.finalValue);
    saveBtn.title = precisionSaveReason(summary);
  } else {
    saveBtn.disabled = !state.settled;
    saveBtn.title = state.settled ? 'Save the settled average for the selected side.' : 'Hold steady until stability turns to Settled.';
  }
  el('quick-control-hint').textContent = saveBtn.title;
}

function refreshSaveConfirmation() {
  const confirmation = el('save-confirmation');
  confirmation.textContent = state.lastSaveConfirmation || '';
  confirmation.classList.toggle('hidden-panel', !state.lastSaveConfirmation);
}

function refreshSavedReadings() {
  document.querySelectorAll('.side-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.side === state.selectedSide);
    button.setAttribute('aria-selected', String(button.dataset.side === state.selectedSide));
  });

  const current = measurementFor(state.mode, state.selectedSide);
  el('saved-side-title').textContent = `${MODE_LABELS[state.mode]} · ${state.selectedSide}`;
  el('saved-side-value').textContent = current ? formatSigned(current.value) : 'No saved reading';
  el('saved-side-note').textContent = current
    ? [
        `Saved ${formatTime(current.time)}`,
        current.workflow === 'precision' ? `precision ${current.repeatabilityScore || 0}%` : `${current.confidence}% confidence`,
        current.workflow === 'precision' && current.trustVerdict ? current.trustVerdict : `${current.samples} samples`,
      ].join(' • ')
    : `Hold the phone steady until it settles, then tap ${state.workflow === 'precision' ? 'Save Precision' : 'Save Avg'}.`;

  const frontDelta = deltaFor(state.mode, 'FL', 'FR');
  const rearDelta = deltaFor(state.mode, 'RL', 'RR');
  el('front-delta').textContent = frontDelta === null ? '—' : formatSigned(frontDelta);
  el('front-delta-note').textContent = frontDelta === null ? 'Save both front sides for this mode.' : 'A negative delta means FL is smaller than FR.';
  el('rear-delta').textContent = rearDelta === null ? '—' : formatSigned(rearDelta);
  el('rear-delta-note').textContent = rearDelta === null ? 'Save both rear sides for this mode.' : 'A negative delta means RL is smaller than RR.';

  const list = el('saved-list');
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
  el('raw-alpha').textContent = `${formatNumber(state.alpha)}°`;
  el('raw-beta').textContent = `${formatNumber(state.beta)}°`;
  el('raw-gamma').textContent = `${formatNumber(state.gamma)}°`;
  el('sample-spread').textContent = `${formatNumber(sampleRange())}° range • ${formatNumber(sampleStdDev())}° σ`;

  const list = el('mode-cal-list');
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
  refreshReadiness();
  refreshGauge();
  refreshStatus();
  refreshCalibrationCard();
  refreshPrecisionCard();
  refreshLockButton();
  refreshSavedReadings();
  refreshAdvanced();
  refreshSaveConfirmation();
  refreshAriaState();
}

function refreshLiveUI() {
  state.screenOrientation = currentOrientation();
  state.orientationOk = state.screenOrientation === preferredOrientation();
  refreshGuide();
  refreshReadiness();
  refreshGauge();
  refreshStatus();
  refreshLockButton();
  refreshAdvanced();
  refreshSaveConfirmation();
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
      retrySensors: () => retrySensors(),
      showInstructions: () => showInstructions(),
      performGuideAction: () => performGuideAction(),
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

  const fixtureSelect = el('fixture-select');
  fixtureSelect.addEventListener('change', event => {
    selectFixture(event.target.value);
  });

  el('fixture-form').addEventListener('submit', handleFixtureFormSubmit);
  el('fixture-form-cancel').addEventListener('click', closeFixtureDialog);
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
  syncScreenVisibility();
  const handleOrientationFlip = () => {
    const nextOrientation = currentOrientation();
    if (nextOrientation !== state.screenOrientation) {
      resetLiveAveraging();
    }
    refreshUI();
  };
  window.addEventListener('resize', handleOrientationFlip);
  window.addEventListener('orientationchange', () => {
    resetLiveAveraging();
    refreshUI();
  });
  refreshUI();
})();
