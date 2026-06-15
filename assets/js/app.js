import {
  applyScaleCalibration,
  average,
  buildArcPath,
  calibrationZeroValid,
  captureSeriesStats,
  clampAngle as clampAngleInRange,
  computeSampleQuality,
  computeToeWizardResult,
  computeToeStringBoxResult,
  deltaContextMatch,
  flipSelfTest,
  gravityFromEuler,
  headingTrust,
  inclinationForMode,
  motionIsQuasiStatic,
  normalizeBaselinePoint,
  normalizeCalibrationMeta,
  normalizeCaptureSnapshot,
  normalizeMeasurement,
  polarPoint,
  poseOkForMode,
  poseOrientation,
  preferredOrientationForMode,
  scaleGainFromReference,
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
const MODES = ['level', 'camber', 'toe', 'pitch'];
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
  // A gravity sensor is blind to rotation about vertical AND has no vehicle-centerline reference, so
  // toe is NOT a measured inclination. It is a real GUIDED GEOMETRIC calculator now (plates/tape
  // TOTAL toe + precision string-box per-wheel/thrust), so label it "geometric", not "experimental".
  toe: 'Toe (geometric)',
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
    // Toe is geometric, not an inclinometer reading. The guided toe wizard above IS the workflow;
    // these lines point the user at the measured-gap method instead of implying the phone tilts.
    placement: 'Toe is geometric: use the wizard above — enter measured rim/plate gaps, not phone tilt',
    orientation: 'Portrait',
    calibration: 'The phone cannot sense toe — the wizard computes atan(front-vs-rear offset / measured D). Roll & re-measure to cancel runout.',
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
// devicemotion gravity is considered fresh enough to be the primary tilt source
// for this long after its last sample; beyond it we fall back to Euler reconstruction.
const GRAVITY_FRESH_MS = 400;
const SAMPLE_WINDOW = 12;
const MIN_SAMPLE_COUNT = 6;
// SETTLE THRESHOLDS gate the RAW (un-EMA'd) buffer, which is ~3x noisier than the old smoothed
// stream these were originally tuned for. They were re-tuned up so a hand-held / fixtured phone
// can actually reach "Settled" (the old 0.18/0.08/0.03 made settling effectively impossible on a
// real device — the workflows hung). The displayed ±tolerance band keeps the reading honest about
// real noise. Tune against live "spread σ X°" in the status chip / sensor-check.html if needed.
const SETTLED_RANGE = 0.7;
const SETTLED_STDDEV = 0.3;
const SETTLED_HOLD_MS = 900;
// P0-3 drift gate: half-to-half trend of the RAW buffer must stay under this before settling.
const SETTLED_DRIFT = 0.2;
// P0-6 motion gate: |gravity| must stay within this ratio of expected (~9.81 m/s^2 or ~1g),
// and rotation under ROTATION_TOL deg/s, before a settle is allowed. Widened so normal hand
// tremor while holding the phone does not reset the settle timer every frame.
const MOTION_RATIO_BAND = 0.15;
const ROTATION_TOL = 25;
// P1-6 stream health: if no fresh sensor event arrives within this window, void the settle.
// Generous enough to tolerate iOS throttling / Low Power Mode without falsely voiding a settle.
const STREAM_STALE_MS = 800;
// P1-6 device reference staleness: warn when the saved device profile is older than this.
const DEVICE_PROFILE_STALE_MS = 6 * 60 * 60 * 1000;
// P0-7: a 180° flip self-test passes when the residual bias |(a+b)/2| stays under this many
// degrees, and a pass is considered "recent" (good enough to gate trust wording) for this long.
const SELF_TEST_TOLERANCE_DEG = 0.2;
const SELF_TEST_FRESH_MS = 30 * 60 * 1000;
// P1-5: forward precision sets need to reach the 5-capture verdict minimum, so the ring
// buffer keeps a little headroom above it. Baseline points keep their own smaller cap.
const PRECISION_CAPTURE_TARGET = 6;
const BASELINE_POINT_TARGET = 3;
const BASELINE_CAPTURE_TARGET = 2;
// P2-3: how many PRIOR saved values to keep per mode+side so a save no longer blindly discards
// the previous reading (a small history, not the full log).
const MEASUREMENT_HISTORY_DEPTH = 4;
// GEOMETRIC TOE wizard: toe is NOT a sensor reading (a gravity inclinometer is blind to rotation
// about vertical). The wizard is a pure geometric calculator. Default read uncertainty is 0.8 mm
// (1/32 in), supplied in the SAME units the user is working in. The runout/seating disagreement
// threshold is the headline caveat — it is the dominant toe error, so the two forced read-pairs
// must agree within this many degrees before a save is trusted.
const TOE_DEFAULT_READ_UNCERTAINTY = { mm: 0.8, in: 0.8 / 25.4 };
const TOE_RUNOUT_THRESHOLD_DEG = 0.25;

const state = {
  mode: 'level',
  workflow: 'quick',
  alpha: 0,
  beta: 0,
  gamma: 0,
  smoothed: { alpha: null, beta: null, gamma: null },
  // Raw accelerometer gravity (device frame) from devicemotion; primary tilt source.
  // smoothedGravity holds the EMA-smoothed components used before computing the angle.
  gravity: null,
  gravityTime: 0,
  gravityMagnitude: null,
  gravityFresh: false,
  smoothedGravity: { x: null, y: null, z: null },
  // Latest devicemotion rotationRate (deg/s) for the P0-6 quasi-static motion gate.
  rotationRate: null,
  // Timestamp (event.timeStamp / performance.now domain) of the last sensor event, for the
  // P1-6 stream-health staleness check; lastSensorWallTime is the Date.now() equivalent.
  lastSensorEventTime: 0,
  lastSensorWallTime: 0,
  // P0-5: true while the chosen gravity/axis yields no finite reading (don't feed 0 in).
  readingMissing: false,
  // P0/UX: which gate is currently preventing a settle (from computeSampleQuality), so the
  // workflow can tell the user WHY it is not settling instead of hanging silently.
  settleBlockedBy: null,
  // P2-4: compass/heading awareness. headingTrusted is true only when an ABSOLUTE compass heading
  // with acceptable accuracy is available; otherwise heading is relative/poor and must NOT be used
  // as a yaw reference (raw alpha is never trusted). heading/headingAccuracy/headingReason hold the
  // last verdict for the UI warning that supports future toe/squareness work.
  headingTrusted: false,
  heading: null,
  headingAccuracy: null,
  headingReason: 'unavailable',
  calibrationOffsets: defaultOffsets(),
  calibrationMeta: defaultCalibrationMeta(),
  deviceProfile: null,
  fixtureProfiles: [],
  precisionSession: defaultPrecisionSession(),
  sampleBuffer: [],
  // P0-3: parallel ring buffer of the UN-smoothed calibrated angle. Stability, drift, and
  // confidence are computed on THIS buffer; sampleBuffer (EMA-smoothed) drives only display.
  rawSampleBuffer: [],
  // P1-4: 95% +/- half-width in degrees for the current live reading (null until estimable).
  toleranceDeg: null,
  confidence: 0,
  settled: false,
  settledStart: 0,
  aligned: false,
  alignedStart: 0,
  // locked freezes the current reading for save/review; sensorListenerAttached is the actual telemetry on/off state.
  locked: false,
  sensorsAvailable: false,
  sensorListenerAttached: false,
  prevScreen: null,
  selectedSide: 'FL',
  measurements: [],
  screenOrientation: 'portrait',
  // P0-4: orientationOk now reflects PHYSICAL pose (gravity-derived), not screen aspect ratio.
  // It is advisory only — a confidence penalty + non-blocking warning, never a settle gate.
  orientationOk: true,
  poseOk: true,
  notice: null,
  lastSaveConfirmation: null,
  liveRefreshScheduled: false,
  // P0-7: guided 180° flip trueness self-test. firstReading holds reading A until the flip;
  // result holds the last {mode, residualBias, asymmetry, corrected, passed, tolerance, time}.
  selfTest: { mode: null, firstReading: null, result: null },
  // GEOMETRIC TOE wizard: pure, sensor-free calculator state. setup holds the mandatory reference
  // diameter/units/spec/read-uncertainty; reads holds the two forced read-pairs (roll-and-average);
  // method picks plates vs tape; saveSide maps the result onto the FL/FR/RL/RR measurements model.
  toeWizard: defaultToeWizard(),
};

function defaultToeWizard() {
  return {
    method: 'plates',
    units: 'mm',
    specType: 'total',
    diameter: null,
    specDiameter: null,
    readUncertainty: TOE_DEFAULT_READ_UNCERTAINTY.mm,
    reads: [
      { front: null, rear: null },
      { front: null, rear: null },
    ],
    // PRECISION string-box: transient per-corner string-to-rim gaps (front/rear) for the four
    // wheels. Like the gap reads, these are never persisted — only the wizard SETUP survives reload.
    stringBox: defaultToeStringBox(),
    saveSide: 'front',
  };
}

// PRECISION string-box: empty per-corner front/rear string offsets for FL/FR/RL/RR.
function defaultToeStringBox() {
  return SIDES.reduce((acc, side) => {
    acc[side] = { front: null, rear: null };
    return acc;
  }, {});
}

// GEOMETRIC TOE: tolerant migration of a persisted wizard setup. Unknown/old data falls back to the
// defaults; the transient gap reads are never persisted, so they always start empty.
function restoreToeWizardSetup(stored) {
  const wizard = defaultToeWizard();
  if (!stored || typeof stored !== 'object') return wizard;
  wizard.method = stored.method === 'tape' ? 'tape' : 'plates';
  wizard.units = stored.units === 'in' ? 'in' : 'mm';
  wizard.specType = stored.specType === 'perWheel' ? 'perWheel' : 'total';
  wizard.diameter = Number.isFinite(stored.diameter) && stored.diameter > 0 ? stored.diameter : null;
  wizard.specDiameter = Number.isFinite(stored.specDiameter) && stored.specDiameter > 0 ? stored.specDiameter : null;
  wizard.readUncertainty = Number.isFinite(stored.readUncertainty) && stored.readUncertainty >= 0
    ? stored.readUncertainty
    : TOE_DEFAULT_READ_UNCERTAINTY[wizard.units];
  wizard.saveSide = ['front', 'rear', ...SIDES].includes(stored.saveSide) ? stored.saveSide : 'front';
  return wizard;
}

// GEOMETRIC TOE: the pure orchestrator result for the current wizard inputs (sensor-free).
function toeWizardResult() {
  const w = state.toeWizard;
  return computeToeWizardResult({
    method: w.method,
    diameter: w.diameter,
    specType: w.specType,
    specDiameter: w.specDiameter,
    readUncertainty: w.readUncertainty,
    runoutThreshold: TOE_RUNOUT_THRESHOLD_DEG,
  }, w.reads);
}

// GEOMETRIC TOE — PRECISION string-box: the pure per-wheel/thrust result for the current corner
// inputs (sensor-free). Reuses the wizard's reference diameter, spec diameter, and read uncertainty.
function toeStringBoxResult() {
  const w = state.toeWizard;
  return computeToeStringBoxResult({
    diameter: w.diameter,
    specDiameter: w.specDiameter,
    readUncertainty: w.readUncertainty,
  }, w.stringBox);
}

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
  // Keep branches aligned with MODES order so tab/default workflow ordering stays easy to scan.
  if (state.mode === 'level') {
    return angleDeg > DIRECTION_DEADBAND_DEG ? '↗ Tilts Right' : angleDeg < -DIRECTION_DEADBAND_DEG ? '↖ Tilts Left' : '— Level';
  }
  if (state.mode === 'camber') {
    return angleDeg > DIRECTION_DEADBAND_DEG ? '▲ Positive Camber' : angleDeg < -DIRECTION_DEADBAND_DEG ? '▼ Negative Camber' : '— Zero Camber';
  }
  if (state.mode === 'toe') {
    // P0-2: never present a toe-in/out direction — the sensor cannot measure toe. Toe mode has no
    // gravity-derived reading (inclinationForMode('toe') === null), so this is a fixed reminder.
    return '— Toe is geometric (not a sensor reading)';
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

// P1-4: render the +/- 95% band in degrees, e.g. "±0.04°". Null until enough samples.
function formatTolerance(value) {
  return Number.isFinite(value) ? `±${value.toFixed(2)}°` : '±—';
}

// P0-4 (Stage 5 band display): a saved value read as "+X.XX° ± Y.YY° (95%)" so the band is part
// of the number, not a footnote. Falls back to the bare signed value when no band is available.
function formatValueWithBand(value, toleranceDeg) {
  const base = formatSigned(value);
  if (!Number.isFinite(toleranceDeg)) return base;
  return `${base} ${formatTolerance(toleranceDeg)} (95%)`;
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
  // P1-1: record the RAW (pre-calibration) angle and the per-mode offset that was active so the
  // reversal step can cancel the shared zero in (F_raw - R_raw)/2 even if the operator re-zeros
  // between forward and reverse. `value` stays the display-only calibrated reading. rawAngle is
  // the un-offset/un-scaled gravity angle; it falls back to (value/gain + offset) when no live
  // angle is available (e.g. toe), so rawValue - offsetUsed reconstructs the pre-scale value.
  const value = Number(sampleAverage().toFixed(3));
  const offsetUsed = effectiveOffset(state.mode);
  const gainUsed = effectiveGain(state.mode);
  const rawAngle = rawAngleForMode(state.mode);
  const rawValue = Number((rawAngle === null ? (value / (gainUsed || 1)) + offsetUsed : rawAngle).toFixed(3));
  return {
    value,
    rawValue,
    offsetUsed: Number(offsetUsed.toFixed(3)),
    // P2-1 / P2-3: stamp the multiplicative gain that was active so the capture's full calibration
    // context is recoverable later (and a re-scale between captures is detectable like a re-zero).
    gainUsed: Number((gainUsed || 1).toFixed(4)),
    confidence: state.confidence,
    samples: state.sampleBuffer.length,
    range: Number(sampleRange().toFixed(3)),
    stdDev: Number(sampleStdDev().toFixed(3)),
    // P1-4 / P2-3: the live +/- band travels with the capture context.
    toleranceDeg: Number.isFinite(state.toleranceDeg) ? Number(state.toleranceDeg.toFixed(3)) : null,
    orientation: state.screenOrientation,
    // P2-3: pose (gravity-derived) and the device-reference id/time stamp the physical context so
    // a delta computed across mismatched contexts can be flagged later.
    pose: currentPoseOrientation(),
    deviceRefTime: state.deviceProfile?.time || null,
    fixtureId: state.precisionSession.fixtureId || '',
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

// Screen aspect ratio. P0-4: this is now only a SECONDARY hint (display label, fallback when
// gravity is unavailable) — physical pose drives the real orientation/pose checks below.
function currentOrientation() {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

// P0-4 / P1-3a: the live orientation family derived from PHYSICAL pose (gravity), falling back
// to the screen aspect ratio only when no gravity vector is available. Used for the pose hint
// and for binding a stored zero to the pose it was captured in.
function currentPoseOrientation() {
  return poseOrientation(gravityForAngle()) || currentOrientation();
}

function preferredOrientation(mode = state.mode) {
  return preferredOrientationForMode(mode);
}

function orientationLabel(value) {
  return value === 'landscape' ? 'Landscape' : 'Portrait';
}

// Pick the best available gravity vector: fresh devicemotion gravity (the robust source
// that bypasses the Euler gimbal-lock/clamp), else reconstruct it from the orientation
// Euler angles (weak for camber near beta ~= ±90). `useRaw` chooses the UN-smoothed
// components/angles (P0-3: stability must be measured on the raw stream), while the
// default smoothed source drives the displayed needle/bubble.
function gravityForAngle(useRaw = false) {
  if (useRaw) {
    const g = state.gravity;
    if (state.gravityFresh && g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z)) {
      return { x: g.x, y: g.y, z: g.z };
    }
    return gravityFromEuler({ beta: state.beta, gamma: state.gamma });
  }
  const sg = state.smoothedGravity;
  if (state.gravityFresh && Number.isFinite(sg.x) && Number.isFinite(sg.y) && Number.isFinite(sg.z)) {
    return { x: sg.x, y: sg.y, z: sg.z };
  }
  return gravityFromEuler(state.smoothed);
}

// P0-4: refresh the orientation/pose state from PHYSICAL pose. screenOrientation keeps the
// screen aspect ratio as a display label/secondary hint, but orientationOk/poseOk are derived
// from the gravity vector so a settle is never blocked by aspect ratio. poseOk is advisory.
function updateOrientationPose() {
  state.screenOrientation = currentOrientation();
  state.poseOk = poseOkForMode(state.mode, gravityForAngle());
  state.orientationOk = state.poseOk;
}

function rawAngleForMode(mode = state.mode, useRaw = false) {
  const gravity = gravityForAngle(useRaw);
  const angle = inclinationForMode(mode, gravity);
  // P1-3b: the global device-bias subtraction is GONE. Previously calibrate() stored `raw`
  // (already bias-subtracted) and calibratedAngle() subtracted that offset again, so the bias
  // cancelled to a no-op for any zeroed mode while silently shifting only un-zeroed modes — a
  // contradiction. We pick the roadmap's "drop" mechanism: per-mode zeros are the sole zero
  // reference. captureDeviceCalibration still records axisBias for the (later) staleness/scale
  // features, but it no longer feeds the live angle, so it can never produce that silent shift.
  return Number.isFinite(angle) ? angle : null;
}

// P1-3a: a stored per-mode zero is only valid when its capture orientation matches the mode's
// preferred family AND the phone is currently posed in that same family. Returns true when the
// stored zero may be applied; false treats the mode as NOT zeroed (the "Zero this mode"
// guidance surfaces) rather than silently applying an offset taken in the wrong pose.
function zeroValidForCurrentPose(mode = state.mode) {
  return calibrationZeroValid(mode, state.calibrationMeta[mode], currentPoseOrientation());
}

// P1-3a: the offset to subtract, bound to orientation/pose. When the stored zero does not
// match the current pose family it is discarded (offset 0) so the mode reads as un-zeroed.
function effectiveOffset(mode = state.mode) {
  return zeroValidForCurrentPose(mode) ? (state.calibrationOffsets[mode] || 0) : 0;
}

// P2-1: the multiplicative scale gain to apply, bound to the same pose validity as the zero (a
// scale captured against a known wedge only makes sense in the mode's pose). Defaults to 1
// (no-op) when no scale was captured or the stored zero is not valid for the current pose.
function effectiveGain(mode = state.mode) {
  if (!zeroValidForCurrentPose(mode)) return 1;
  const gain = state.calibrationMeta[mode]?.gain;
  return Number.isFinite(gain) && gain > 0 ? gain : 1;
}

// P2-1: has a two-point scale been captured for this mode?
function modeHasScale(mode = state.mode) {
  return Number.isFinite(state.calibrationMeta[mode]?.gain) && state.calibrationMeta[mode].gain > 0;
}

// P1-3a: "is this mode effectively zeroed RIGHT NOW?" — a stored zero captured in the wrong
// orientation family (or while the phone is currently posed in the wrong family) counts as
// not zeroed, so the workflow re-surfaces the "Zero this mode" guidance instead of trusting
// a mismatched offset. Display surfaces still read state.calibrationMeta directly so the user
// can see a stored-but-inactive zero and why it is being ignored.
function modeIsZeroed(mode = state.mode) {
  return zeroValidForCurrentPose(mode);
}

// P1-3a: a stored zero exists for this mode but does not match the current pose/orientation,
// so it is being ignored. Drives a clarifying hint in the calibration card/chip.
function modeZeroOrientationMismatch(mode = state.mode) {
  return !!state.calibrationMeta[mode] && !zeroValidForCurrentPose(mode);
}

function calibratedAngle(mode = state.mode) {
  // P2-1: calibrated = (raw - offset) * gain. Subtracts the additive zero, then applies the
  // optional two-point scale gain (default 1). Returns null when the underlying gravity-vector
  // angle is unavailable (e.g. toe, or no sensor yet). P1-3a: offset and gain are only applied
  // when the stored zero matches the current pose family.
  const raw = rawAngleForMode(mode);
  return applyScaleCalibration(raw, effectiveOffset(mode), effectiveGain(mode));
}

// P0-3: the un-smoothed calibrated angle that feeds rawSampleBuffer (stability/drift/conf).
function rawCalibratedAngle(mode = state.mode) {
  const raw = rawAngleForMode(mode, true);
  return applyScaleCalibration(raw, effectiveOffset(mode), effectiveGain(mode));
}

function sampleAverage() {
  if (!state.sampleBuffer.length) {
    const angle = calibratedAngle();
    return angle === null ? 0 : angle;
  }
  return average(state.sampleBuffer);
}

// Stability metrics report on the RAW (un-EMA'd) buffer so displayed spread/σ match the
// gate that decides settled (P0-3); the smoothed buffer is only for the displayed value.
function sampleRange() {
  if (!state.rawSampleBuffer.length) return 0;
  return Math.max(...state.rawSampleBuffer) - Math.min(...state.rawSampleBuffer);
}

function sampleStdDev() {
  return standardDeviation(state.rawSampleBuffer);
}

function resetLiveAveraging() {
  state.sampleBuffer = [];
  state.rawSampleBuffer = [];
  state.toleranceDeg = null;
  state.readingMissing = false;
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

function pushRawSample(value) {
  state.rawSampleBuffer.push(value);
  if (state.rawSampleBuffer.length > SAMPLE_WINDOW) {
    state.rawSampleBuffer.shift();
  }
}

// P1-6: has a fresh sensor event arrived recently enough to trust a live settle?
function streamIsHealthy(now = Date.now()) {
  return !!state.lastSensorWallTime && (now - state.lastSensorWallTime) <= STREAM_STALE_MS;
}

// P1-6: warn when the saved device reference is older than the staleness window.
function deviceProfileIsStale(now = Date.now()) {
  if (!state.deviceProfile?.time) return false;
  const captured = new Date(state.deviceProfile.time).getTime();
  if (Number.isNaN(captured)) return false;
  return (now - captured) > DEVICE_PROFILE_STALE_MS;
}

function updateSampleQuality() {
  const now = Date.now();
  // P0-6: only allow a settle when the device is quasi-static (|g| near expected, low spin).
  const motionOk = motionIsQuasiStatic({
    gravityMagnitude: state.gravityFresh ? state.gravityMagnitude : null,
    ratioBand: MOTION_RATIO_BAND,
    rotationRate: state.rotationRate,
    rotationTol: ROTATION_TOL,
  });
  // P1-6: void settle if the sensor stream has gone stale.
  const streamOk = streamIsHealthy(now);
  // P0-5: block settle when the current reading is missing (no finite gravity-derived angle).
  const readingOk = !state.readingMissing;
  // P0-3: stability/drift/confidence are computed on the RAW (un-EMA'd) buffer; with rho~0
  // the tolerance N_eff ~= N so smoothingAlpha stays 0 here.
  const result = computeSampleQuality({
    sampleBuffer: state.rawSampleBuffer,
    // P0-4: orientationOk is the physical-pose hint (confidence penalty only, not a gate).
    orientationOk: state.poseOk,
    // P1-3a: an orientation-mismatched zero counts as not set for confidence purposes.
    calibrationSet: modeIsZeroed(),
    now,
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
    driftTol: SETTLED_DRIFT,
    readingOk,
    motionOk,
    streamOk,
    smoothingAlpha: 0,
  });
  state.settledStart = result.settledStart;
  state.alignedStart = result.alignedStart;
  state.settled = result.settled;
  state.aligned = result.aligned;
  state.confidence = result.confidence;
  state.toleranceDeg = result.toleranceDeg;
  state.settleBlockedBy = result.blockedBy;
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
      // P2-5: pure, tested normalization/migration (offset + optional P2-1 scale gain).
      const normalized = normalizeCalibrationMeta(parsed?.calibrationMeta?.[mode]);
      if (normalized) meta[mode] = normalized;
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
        .map(item => normalizeBaselinePoint(item));
      return acc;
    }, {});
    const captures = {};
    const rawCaptures = parsedSession?.captures && typeof parsedSession.captures === 'object' ? parsedSession.captures : {};
    Object.entries(rawCaptures).forEach(([key, item]) => {
      if (!item || !MODES.includes(item.mode) || !SIDES.includes(item.side)) return;
      const normalizeSeries = series => (Array.isArray(series) ? series : [])
        .filter(entry => Number.isFinite(entry?.value))
        .map(entry => normalizeCaptureSnapshot(entry));
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
      // P2-5: pure, tested normalization incl. P2-3 context stamps and bounded save history.
      .map(item => normalizeMeasurement(item, new Date().toISOString(), MEASUREMENT_HISTORY_DEPTH));
    // GEOMETRIC TOE: restore the wizard SETUP tolerantly (older data simply has none -> defaults).
    state.toeWizard = restoreToeWizardSetup(parsed?.toeWizardSetup);
  } catch (error) {
    state.calibrationOffsets = defaultOffsets();
    state.calibrationMeta = defaultCalibrationMeta();
    state.workflow = 'quick';
    state.deviceProfile = null;
    state.fixtureProfiles = [];
    state.precisionSession = defaultPrecisionSession();
    state.measurements = [];
    state.toeWizard = defaultToeWizard();
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
      // GEOMETRIC TOE: persist only the wizard SETUP (diameter/units/spec/uncertainty/method/side),
      // not the transient gap reads, so a returning user keeps their reference context.
      toeWizardSetup: {
        method: state.toeWizard.method,
        units: state.toeWizard.units,
        specType: state.toeWizard.specType,
        diameter: state.toeWizard.diameter,
        specDiameter: state.toeWizard.specDiameter,
        readUncertainty: state.toeWizard.readUncertainty,
        saveSide: state.toeWizard.saveSide,
      },
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
  window.addEventListener('devicemotion', onMotion, true);
  state.sensorListenerAttached = true;
}

function detachSensorListener() {
  if (!state.sensorListenerAttached) return;
  window.removeEventListener('deviceorientation', onOrientation, true);
  window.removeEventListener('devicemotion', onMotion, true);
  state.sensorListenerAttached = false;
}

function gravityIsFresh(now = Date.now()) {
  return !!state.gravity && (now - state.gravityTime) <= GRAVITY_FRESH_MS;
}

function pauseSensors() {
  // Pausing intentionally both freezes the latest reading and detaches telemetry until Start Measuring is tapped.
  state.locked = true;
  detachSensorListener();
}

function onMotion(event) {
  if (state.locked) return;
  // accelerationIncludingGravity measures the gravity direction directly in the device
  // frame, bypassing the Euler gimbal-lock singularity and the gamma clamp. This is the
  // robust primary source for camber (portrait, beta ~= ±90) where Euler angles degrade.
  const g = event.accelerationIncludingGravity;
  if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.z)) return;

  // SIGN NORMALIZATION (Stage 7 fix): gravityFromEuler returns the gravity-DIRECTION unit
  // vector (flat screen-up => z = -1). iOS Safari's accelerationIncludingGravity is the
  // device-frame specific-force vector, NEGATED relative to that direction (flat screen-up
  // reads z ~= +9.81). Both sources feed the SAME camberDeg/levelDeg/pitchDeg functions, so
  // we negate here at the single capture point to match the Euler convention BEFORE the value
  // reaches state.gravity (raw path) and state.smoothedGravity (display path). Without this,
  // on-device readings are inverted (camber ~180deg, pitch/level sign-flipped) whenever motion
  // permission is granted, while the Euler fallback stays self-consistent. magnitude/pose
  // checks below use hypot/abs and are sign-robust, so they are unaffected by this negation.
  // VERIFY ON-DEVICE: flat screen-up should give normalized z = -1, upright portrait +y.
  state.gravity = { x: -g.x, y: -g.y, z: -g.z };
  state.gravityTime = Date.now();
  // |g| feeds the P0-6 quasi-static motion gate: when the device is moved/pressed, |g|
  // strays from the expected magnitude (~9.81 m/s^2 or ~1g) and the settle is rejected.
  state.gravityMagnitude = Math.hypot(g.x, g.y, g.z);
  // P0-6: rotationRate (deg/s) lets the gate reject captures during a press/vibration even
  // when |g| momentarily looks fine. Absent on some platforms; gate treats null as "unknown".
  const rr = event.rotationRate;
  state.rotationRate = rr && Number.isFinite(rr.alpha) && Number.isFinite(rr.beta) && Number.isFinite(rr.gamma)
    ? { alpha: rr.alpha, beta: rr.beta, gamma: rr.gamma }
    : null;
  // P1-6: stamp the stream so staleness can void a settle if events stop arriving.
  state.lastSensorEventTime = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
  state.lastSensorWallTime = Date.now();

  // Smooth the gravity COMPONENTS before computing any angle (atan2 must see smoothed input).
  ['x', 'y', 'z'].forEach(axis => {
    const next = state.gravity[axis];
    const prev = state.smoothedGravity[axis];
    state.smoothedGravity[axis] = prev === null ? next : prev + (next - prev) * SMOOTHING_ALPHA;
  });
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

  state.gravityFresh = gravityIsFresh();
  // P0-4: refresh the physical-pose hint (gravity-based), not the screen aspect ratio.
  updateOrientationPose();
  // P2-4: read the compass/heading. iOS exposes webkitCompassHeading (+ webkitCompassAccuracy);
  // the W3C `absolute` flag says whether alpha is earth-referenced at all. We NEVER use raw alpha
  // as a yaw reference — only a trusted absolute compass heading counts, and indoor magnetic
  // distortion (poor/negative accuracy) is surfaced as a warning for the future toe/squareness work.
  const trust = headingTrust({
    absolute: !!event.absolute,
    webkitCompassHeading: Number.isFinite(event.webkitCompassHeading) ? event.webkitCompassHeading : null,
    webkitCompassAccuracy: Number.isFinite(event.webkitCompassAccuracy) ? event.webkitCompassAccuracy : null,
  });
  state.headingTrusted = trust.trusted;
  state.heading = trust.heading;
  state.headingAccuracy = trust.accuracy;
  state.headingReason = trust.reason || (trust.trusted ? 'trusted' : 'unavailable');
  // P1-6: orientation events keep the stream alive too.
  state.lastSensorEventTime = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
  state.lastSensorWallTime = Date.now();

  // Smoothed angle drives the displayed needle/bubble; the raw angle drives stability.
  const sample = calibratedAngle();
  const rawSample = rawCalibratedAngle();
  // P0-5: a null reading is a real "no reading", not a 0. Do not push it into either
  // buffer, and flag readingMissing so the settle/save gate blocks and the UI can say so.
  state.readingMissing = rawSample === null;
  if (sample !== null) pushSample(sample);
  if (rawSample !== null) pushRawSample(rawSample);
  updateSampleQuality();
  scheduleLiveRefresh();
}

function requestMotionPermission() {
  // iOS requires a separate motion permission, requested in the same user gesture as the
  // orientation permission. Failure is non-fatal: rawAngleForMode() falls back to Euler.
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().catch(() => {});
  }
}

function requestSensors(callback) {
  requestMotionPermission();
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
    // Instructions are a non-measurement screen; users restart telemetry explicitly with Start Measuring.
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
  updateOrientationPose();
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
  // P1-3b: the device reference is now INFORMATIONAL. Per-mode zeros are the sole live zero, so
  // this captured bias no longer shifts readings — it is recorded for staleness/scale features.
  setNotice('Device reference recorded (informational). Per-mode zeros remain the live reference.', 'good');
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
  if (raw === null) {
    setNotice('No gravity-derived angle is available for this mode yet. Hold the phone steady and try again.', 'warn');
    refreshUI();
    return;
  }
  // P1-3a: bind the zero to the PHYSICAL pose it was captured in (gravity-derived), so the
  // stored orientation matches the family the calibration-validity check enforces later.
  const captureOrientation = currentPoseOrientation();
  state.calibrationOffsets[state.mode] = raw;
  state.calibrationMeta[state.mode] = {
    offset: raw,
    time: new Date().toISOString(),
    orientation: captureOrientation,
  };
  resetLiveAveraging();
  saveState();
  // P1-3a: warn if the user zeroed out of the mode's preferred pose — the offset will be parked
  // inactive until they re-zero in the right pose, so flag it now rather than silently storing it.
  if (captureOrientation !== preferredOrientation()) {
    setNotice(`${MODE_LABELS[state.mode]} zero captured in ${orientationLabel(captureOrientation)} pose — re-zero in ${MODE_GUIDES[state.mode].orientation} pose to apply it.`, 'warn');
  } else {
    setNotice(`${MODE_LABELS[state.mode]} set to zero and saved locally.`, 'good');
  }
  refreshUI();
}

// P2-1: two-point SCALE calibration. After zeroing, hold the phone on a KNOWN reference angle
// (e.g. a machined 10° wedge) and enter that true angle; gain = trueAngle / measuredAngle scales
// every subsequent reading. Requires the mode to already be zeroed in the right pose so the
// measured value is the post-zero deflection. Default gain stays 1 until this is captured.
function calibrateScale() {
  if (!state.sensorListenerAttached) {
    setNotice('Tap Start Measuring before capturing a scale reference.', 'warn');
    refreshUI();
    return;
  }
  if (state.mode === 'toe') {
    setNotice('Toe has no sensor reading, so a scale reference does not apply. Measure toe geometrically.', 'warn');
    refreshUI();
    return;
  }
  if (!modeIsZeroed()) {
    setNotice('Zero this mode in the correct pose before capturing a scale reference.', 'warn');
    refreshUI();
    return;
  }
  if (!state.settled) {
    setNotice('Hold the phone steady on the known angle until it settles before capturing the scale.', 'warn');
    refreshUI();
    return;
  }
  // The measured deflection is the post-zero angle WITHOUT the existing gain (we are recomputing it).
  const raw = rawAngleForMode();
  if (raw === null) {
    setNotice('No gravity-derived angle is available for this mode yet. Hold steady and try again.', 'warn');
    refreshUI();
    return;
  }
  const measured = raw - effectiveOffset();
  const entry = window.prompt(`Enter the KNOWN reference angle in degrees (measured ${formatSigned(measured)}).`, '');
  if (entry === null) return;
  const trueAngle = Number(entry.trim());
  const gain = scaleGainFromReference(trueAngle, measured);
  if (gain === null) {
    setNotice('Could not derive a plausible scale from that reference. Use a known angle well away from zero.', 'warn');
    refreshUI();
    return;
  }
  const meta = state.calibrationMeta[state.mode];
  if (!meta) {
    setNotice('Zero this mode before capturing a scale reference.', 'warn');
    refreshUI();
    return;
  }
  state.calibrationMeta[state.mode] = {
    ...meta,
    gain: Number(gain.toFixed(4)),
    gainReference: Number(trueAngle.toFixed(3)),
    gainTime: new Date().toISOString(),
  };
  resetLiveAveraging();
  saveState();
  setNotice(`${MODE_LABELS[state.mode]} scale set: gain ${gain.toFixed(3)} from a ${formatSigned(trueAngle)} reference.`, 'good');
  refreshUI();
}

function resetScaleCalibration() {
  const meta = state.calibrationMeta[state.mode];
  if (meta) {
    const { gain, gainReference, gainTime, ...rest } = meta;
    state.calibrationMeta[state.mode] = rest;
  }
  resetLiveAveraging();
  saveState();
  setNotice(`${MODE_LABELS[state.mode]} scale reset to 1.00 (zero kept).`, 'warn');
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
  if (!modeIsZeroed()) {
    // P1-3a: an orientation-mismatched zero re-surfaces this step. The reason explains that the
    // stored zero is being ignored because it was captured in the wrong pose family.
    return {
      label: 'Zero this mode',
      action: 'calibrate',
      reason: modeZeroOrientationMismatch()
        ? `${MODE_LABELS[state.mode]} zero was captured in ${orientationLabel(state.calibrationMeta[state.mode].orientation)} — re-zero in ${guide.orientation} pose.`
        : `${MODE_LABELS[state.mode]} is not zeroed yet.`,
    };
  }
  // P0-4: pose mismatch is a non-blocking hint, NOT a guide dead-end. We no longer short-circuit
  // the workflow with a `Rotate to...` step; the pose warning is surfaced in the guide card and
  // the orientation chip instead, and the flow proceeds to capture/settle/save.
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
  // P1-1: a re-zero between flips takes priority — it blocks the save no matter the counts.
  if (summary.offsetConflict) return 'Forward and reversed sets used different zeros — re-capture one set without re-zeroing.';
  if (!Number.isFinite(summary.finalValue)) return 'Capture repeated readings before saving.';
  if (!summary.forward || summary.forward.count < PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_READY) {
    // P1-5: state how many captures are still needed against the displayed forward target.
    return `Need ${PRECISION_CONSTANTS.MIN_PRECISION_CAPTURES_READY} forward captures (have ${summary.forward?.count || 0}).`;
  }
  if (summary.needsReverse && (!summary.reverse || summary.reverse.count < PRECISION_CONSTANTS.REVERSE_CAPTURE_TARGET)) {
    return `Need ${PRECISION_CONSTANTS.REVERSE_CAPTURE_TARGET} reversed captures (have ${summary.reverse?.count || 0}).`;
  }
  // P1-5: surface n with the verdict so trust is read alongside the capture count.
  return `${summary.verdict} • ${summary.repeatabilityScore}% repeatability • n=${summary.n}.`;
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
  state.precisionSession.baselinePoints[side] = state.precisionSession.baselinePoints[side].slice(-BASELINE_POINT_TARGET);
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
  // P0-5: a missing reading must block save with an explicit message, not save a 0.
  if (state.readingMissing) {
    setNotice('No reading right now — no gravity-derived angle is available for this mode. Hold steady and try again.', 'warn');
    refreshUI();
    return;
  }
  if (!state.rawSampleBuffer.length) {
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
    // P1-4: the +/- 95% band travels with the saved reading.
    toleranceDeg: Number.isFinite(state.toleranceDeg) ? Number(state.toleranceDeg.toFixed(3)) : null,
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
    // P2-3: stamp the active calibration/orientation context for the delta-mismatch guard.
    ...currentCalibrationContext(),
  };

  // P2-3: commit with rolling history instead of a blind overwrite.
  commitMeasurement(measurement);
  saveState();
  pauseSensors();
  setSaveConfirmation(`Saved ${MODE_LABELS[state.mode]} · ${state.selectedSide} at ${formatSigned(measurement.value)} with ${measurement.confidence}% confidence.`);
  setNotice(`Saved averaged ${state.mode} reading for ${state.selectedSide}. Measurement paused.`, 'good');
  refreshUI();
}

function savePrecisionMeasurement() {
  const summary = precisionSummary(state.mode, state.selectedSide);
  // P1-1: a re-zero between forward and reverse breaks the (F-R)/2 cancellation — refuse to save.
  if (summary.offsetConflict) {
    setNotice('Forward and reversed captures used different zeros. Do not re-zero between flips — re-capture one set so they share a zero.', 'warn');
    refreshUI();
    return;
  }
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
    // P1-4 / P1-5: the +/- band here comes from the forward set's standard error (sigma/sqrt(n)).
    toleranceDeg: Number.isFinite(summary.toleranceDeg) ? Number(summary.toleranceDeg.toFixed(3)) : null,
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
    // P2-3: stamp the active calibration/orientation context (fixtureId comes from the session).
    ...currentCalibrationContext(),
  };

  // P2-3: commit with rolling history instead of a blind overwrite.
  commitMeasurement(measurement);
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

// P0-7: is there a passed flip self-test recent enough (and for this mode) to back an
// adjustment-grade trust claim? Used to gate the "verify vs a known reference" wording.
function selfTestPassedRecently(mode = state.mode, now = Date.now()) {
  const result = state.selfTest.result;
  if (!result || !result.passed || result.mode !== mode) return false;
  const captured = new Date(result.time).getTime();
  if (Number.isNaN(captured)) return false;
  return (now - captured) <= SELF_TEST_FRESH_MS;
}

// P0-7: guided 180° flip trueness self-test. First press captures reading A; the user flips the
// phone/jig 180° about the measurement axis; the second press captures reading B and reports the
// residual bias (a+b)/2, asymmetry |a+b|, and pass/fail. Toe has no sensor reading, so it is
// excluded. Both readings come from the settled RAW gravity angle (pre-zero) so a per-mode offset
// cannot mask a real sensor/mount bias.
function runFlipSelfTest() {
  if (!state.sensorListenerAttached) {
    setNotice('Tap Start Measuring before running the flip self-test.', 'warn');
    refreshUI();
    return;
  }
  if (state.mode === 'toe') {
    setNotice('Toe has no sensor reading, so the flip self-test does not apply. Measure toe geometrically.', 'warn');
    refreshUI();
    return;
  }
  if (!state.settled) {
    setNotice('Hold the phone steady until it settles before capturing a self-test reading.', 'warn');
    refreshUI();
    return;
  }
  const reading = rawAngleForMode();
  if (reading === null) {
    setNotice('No gravity-derived angle is available for this mode yet. Hold steady and try again.', 'warn');
    refreshUI();
    return;
  }

  // A self-test always belongs to one mode; switching modes mid-test discards the pending A.
  if (state.selfTest.mode !== state.mode) {
    state.selfTest = { mode: state.mode, firstReading: null, result: null };
  }

  if (state.selfTest.firstReading === null) {
    state.selfTest.firstReading = reading;
    resetLiveAveraging();
    setNotice(`Self-test reading A captured (${formatSigned(reading)}). Flip the phone 180° about the ${MODE_LABELS[state.mode]} axis, settle, then capture reading B.`, 'good');
    refreshUI();
    return;
  }

  const test = flipSelfTest(state.selfTest.firstReading, reading, SELF_TEST_TOLERANCE_DEG);
  state.selfTest.result = {
    mode: state.mode,
    firstReading: state.selfTest.firstReading,
    secondReading: reading,
    residualBias: test.residualBias,
    asymmetry: test.asymmetry,
    corrected: test.corrected,
    passed: test.passed,
    tolerance: test.tolerance,
    time: new Date().toISOString(),
  };
  state.selfTest.firstReading = null;
  resetLiveAveraging();
  setNotice(test.passed
    ? `Flip self-test PASSED — residual bias ${formatSigned(test.residualBias)} (≤ ${test.tolerance}°). Reading is symmetric.`
    : `Flip self-test FAILED — residual bias ${formatSigned(test.residualBias)} exceeds ±${test.tolerance}°. Re-seat the fixture or re-zero.`, test.passed ? 'good' : 'warn');
  refreshUI();
}

function resetFlipSelfTest() {
  state.selfTest = { mode: null, firstReading: null, result: null };
  resetLiveAveraging();
  setNotice('Flip self-test cleared.', 'warn');
  refreshUI();
}

// GEOMETRIC TOE: parse a string field into a finite number or null (blank/invalid => null so the
// pure orchestrator treats it as "not entered" rather than 0).
function parseToeNumber(raw) {
  if (typeof raw !== 'string') return Number.isFinite(raw) ? raw : null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// GEOMETRIC TOE: a single input/select change in the wizard. `field` names the setup key or a
// read-pair gap (front1/rear1/front2/rear2). Changing units re-defaults the read uncertainty only
// when the user has not overridden it from the previous unit default.
function setToeInput(field, value) {
  const w = state.toeWizard;
  switch (field) {
    case 'units': {
      const nextUnits = value === 'in' ? 'in' : 'mm';
      const wasDefault = !Number.isFinite(w.readUncertainty)
        || Math.abs(w.readUncertainty - TOE_DEFAULT_READ_UNCERTAINTY[w.units]) < 1e-9;
      w.units = nextUnits;
      if (wasDefault) w.readUncertainty = TOE_DEFAULT_READ_UNCERTAINTY[nextUnits];
      break;
    }
    case 'specType':
      w.specType = value === 'perWheel' ? 'perWheel' : 'total';
      break;
    case 'saveSide':
      w.saveSide = ['front', 'rear', ...SIDES].includes(value) ? value : 'front';
      break;
    case 'diameter':
      w.diameter = parseToeNumber(value);
      break;
    case 'specDiameter':
      w.specDiameter = parseToeNumber(value);
      break;
    case 'readUncertainty':
      w.readUncertainty = parseToeNumber(value);
      break;
    case 'front1': w.reads[0].front = parseToeNumber(value); break;
    case 'rear1': w.reads[0].rear = parseToeNumber(value); break;
    case 'front2': w.reads[1].front = parseToeNumber(value); break;
    case 'rear2': w.reads[1].rear = parseToeNumber(value); break;
    default: return;
  }
  saveState();
  refreshToeWizard();
}

// GEOMETRIC TOE: plates vs tape method toggle. Both yield TOTAL axle toe via the same atan; the
// label/hint copy differs so the procedure coaching matches the chosen method.
function setToeMethod(method) {
  state.toeWizard.method = method === 'tape' ? 'tape' : 'plates';
  saveState();
  refreshToeWizard();
}

// GEOMETRIC TOE: clear the transient gap reads (keeps the persisted setup so the reference context
// survives a reset).
function resetToeWizard() {
  state.toeWizard.reads = [
    { front: null, rear: null },
    { front: null, rear: null },
  ];
  saveState();
  setNotice('Toe read-pairs cleared. Setup kept.', 'warn');
  refreshToeWizard();
}

// PRECISION string-box: a single per-corner string-offset edit. `field` is "SIDE.front" or
// "SIDE.rear" (e.g. "FL.front"). Reads are transient, so this does NOT persist — only re-renders.
function setToeStringInput(field, value) {
  const [side, edge] = String(field).split('.');
  if (!SIDES.includes(side) || (edge !== 'front' && edge !== 'rear')) return;
  state.toeWizard.stringBox[side][edge] = parseToeNumber(value);
  refreshToeWizard();
}

// PRECISION string-box: clear the four-corner string offsets (keeps the persisted setup).
function resetToeStringBox() {
  state.toeWizard.stringBox = defaultToeStringBox();
  setNotice('String-box corners cleared. Setup kept.', 'warn');
  refreshToeWizard();
}

// PRECISION string-box: commit the four per-wheel toe values to FL/FR/RL/RR. Unlike the plates path
// this needs NO symmetry assumption — each corner carries its own measured per-wheel toe, the +/-
// band, and the thrust/linear context stamps. The wizard is the save driver (no sensor settle gate).
function saveToeStringBox() {
  const result = toeStringBoxResult();
  if (!result.ready) {
    setNotice(result.reason || 'Enter all four corners before saving string-box toe.', 'warn');
    refreshToeWizard();
    return;
  }
  const w = state.toeWizard;
  const time = new Date().toISOString();
  const thrustNote = `thrust ${formatSigned(result.thrust)}`;
  const trustVerdict = `Geometric string-box • per-wheel split • ${thrustNote}`;

  SIDES.forEach(side => {
    const perWheel = result.perWheel[side];
    const linear = result.perWheelLinear[side];
    const measurement = {
      id: `toe-${side}`,
      mode: 'toe',
      side,
      value: Number(perWheel.toFixed(2)),
      // Geometric toe has no sensor confidence; trust comes from the band + box squaring.
      confidence: 100,
      toleranceDeg: Number.isFinite(result.toleranceDeg) ? Number(result.toleranceDeg.toFixed(3)) : null,
      samples: 1,
      time,
      workflow: 'geometric',
      rawValue: null,
      correctedValue: null,
      reversalBias: null,
      repeatabilityScore: null,
      captureCount: 1,
      baselineQuality: null,
      trustVerdict,
      // Geometric context stamps. The string-box splits L vs R, so symmetry is NOT assumed.
      toeMethod: 'string-box',
      toeUnits: w.units,
      toeDiameter: w.diameter,
      toeSpecDiameter: w.specDiameter,
      toeTotal: side.startsWith('F')
        ? Number(result.totalFront.toFixed(3))
        : Number(result.totalRear.toFixed(3)),
      toePerWheel: Number(perWheel.toFixed(3)),
      toeLinear: Number.isFinite(linear) ? Number(linear.toFixed(3)) : null,
      toeSymmetryAssumed: false,
      toeThrust: Number(result.thrust.toFixed(3)),
      toeRunoutDisagreement: null,
      toeRunoutFault: false,
      offsetUsed: 0,
      gainUsed: 1,
      orientation: state.screenOrientation,
      pose: currentPoseOrientation(),
      deviceRefTime: null,
      fixtureId: '',
    };
    commitMeasurement(measurement);
  });

  saveState();
  setSaveConfirmation(`Saved string-box per-wheel toe to FL+FR+RL+RR ${formatTolerance(result.toleranceDeg)} • thrust ${formatSigned(result.thrust)}.`);
  setNotice(`Saved geometric string-box toe (per-wheel split, thrust ${formatSigned(result.thrust)}) to all four corners.`, 'good');
  refreshUI();
}

// GEOMETRIC TOE: which FL/FR/RL/RR sides a save targets. "front"/"rear" map a TOTAL/per-wheel toe to
// the corner pair (total saved to both under the symmetry flag); a single side saves to that corner.
function toeSaveSides(saveSide) {
  if (saveSide === 'front') return ['FL', 'FR'];
  if (saveSide === 'rear') return ['RL', 'RR'];
  return SIDES.includes(saveSide) ? [saveSide] : ['FL', 'FR'];
}

// GEOMETRIC TOE: commit the computed toe into the FL/FR/RL/RR measurements model. The wizard is the
// save driver here (NOT the sensor settle gate) — toe has no settled sensor reading. Per-wheel toe
// is saved when the user picked a single corner or a per-wheel spec; the total goes to a pair under
// the symmetry assumption. Each save carries the +/- band and the geometric context stamps so it
// shows in the Workflow results grid and Saved readings card like any other reading.
function saveToeMeasurement() {
  const w = state.toeWizard;
  const result = toeWizardResult();
  if (!result.ready) {
    setNotice(result.reason || 'Enter setup and both read-pairs before saving toe.', 'warn');
    refreshToeWizard();
    return;
  }

  const sides = toeSaveSides(w.saveSide);
  const singleSide = sides.length === 1;
  // A pair save stores the TOTAL toe to both corners under the symmetry flag; a single-corner save
  // stores the per-wheel value (total / 2) for that corner.
  const value = singleSide ? result.perWheelToe : result.totalToe;
  const symmetryAssumed = !singleSide;
  const time = new Date().toISOString();
  const runoutNote = result.runout.exceeds
    ? `runout fault Δ${formatNumber(result.runout.disagreement)}°`
    : 'runout ok';
  const trustVerdict = `Geometric ${w.method}${symmetryAssumed ? ' • total/2 symmetry assumed' : ''} • ${runoutNote}`;

  sides.forEach(side => {
    const measurement = {
      id: `toe-${side}`,
      mode: 'toe',
      side,
      value: Number(value.toFixed(2)),
      // Geometric toe has no sensor confidence; trust comes from the band + runout check.
      confidence: result.runout.exceeds ? 0 : 100,
      // The +/- 95% band from u/D (x sqrt(2)) travels with the saved reading.
      toleranceDeg: Number.isFinite(result.toleranceDeg) ? Number(result.toleranceDeg.toFixed(3)) : null,
      samples: 2,
      time,
      // Distinguish geometric toe saves from sensor-based quick/precision saves.
      workflow: 'geometric',
      rawValue: null,
      correctedValue: null,
      reversalBias: null,
      repeatabilityScore: null,
      captureCount: 2,
      baselineQuality: null,
      trustVerdict,
      // Geometric context stamps (parallel to currentCalibrationContext): the measured reference,
      // method, units, and the runout disagreement so a later comparison is honest about the basis.
      toeMethod: w.method,
      toeUnits: w.units,
      toeDiameter: w.diameter,
      toeSpecDiameter: w.specDiameter,
      toeTotal: Number(result.totalToe.toFixed(3)),
      toePerWheel: Number(result.perWheelToe.toFixed(3)),
      toeLinear: singleSide
        ? (Number.isFinite(result.perWheelLinear) ? Number(result.perWheelLinear.toFixed(3)) : null)
        : (Number.isFinite(result.totalLinear) ? Number(result.totalLinear.toFixed(3)) : null),
      toeSymmetryAssumed: symmetryAssumed,
      toeRunoutDisagreement: result.runout.ready ? Number(result.runout.disagreement.toFixed(3)) : null,
      toeRunoutFault: result.runout.exceeds,
      // P2-3-style context so a cross-corner delta is not silently compared across mismatched bases.
      offsetUsed: 0,
      gainUsed: 1,
      orientation: state.screenOrientation,
      pose: currentPoseOrientation(),
      deviceRefTime: null,
      fixtureId: '',
    };
    commitMeasurement(measurement);
  });

  saveState();
  const sideLabel = sides.join(' + ');
  setSaveConfirmation(`Saved geometric toe ${formatSigned(Number(value.toFixed(2)))} ${formatTolerance(result.toleranceDeg)} to ${sideLabel}.`);
  setNotice(result.runout.exceeds
    ? `Saved toe to ${sideLabel}, but the runout check FAILED (Δ${formatNumber(result.runout.disagreement)}°). Re-seat the rim and re-measure.`
    : `Saved geometric toe for ${sideLabel}.`, result.runout.exceeds ? 'warn' : 'good');
  refreshUI();
}

function measurementFor(mode, side) {
  return state.measurements.find(item => item.mode === mode && item.side === side) || null;
}

// P2-3: the live calibration/orientation context to stamp on a saved reading so a later delta can
// detect when two corners were captured under mismatched contexts (different zero/gain/pose/device
// reference/fixture). All gravity/pose-bound, so they reflect what was actually applied to value.
function currentCalibrationContext() {
  return {
    offsetUsed: Number(effectiveOffset().toFixed(3)),
    gainUsed: Number(effectiveGain().toFixed(4)),
    orientation: state.screenOrientation,
    pose: currentPoseOrientation(),
    deviceRefTime: state.deviceProfile?.time || null,
    fixtureId: state.precisionSession.fixtureId || '',
  };
}

// P2-3: commit a saved reading without blindly discarding the prior one. The previous value (and
// its time/confidence/band) is pushed onto the new reading's bounded history, then the old record
// is replaced. So mode+side keeps a small rolling history instead of overwriting to nothing.
function commitMeasurement(measurement) {
  const prior = measurementFor(measurement.mode, measurement.side);
  const priorHistory = Array.isArray(prior?.history) ? prior.history : [];
  const history = prior
    ? [...priorHistory, {
        value: prior.value,
        time: prior.time,
        confidence: prior.confidence,
        toleranceDeg: prior.toleranceDeg,
        workflow: prior.workflow,
      }].slice(-MEASUREMENT_HISTORY_DEPTH)
    : priorHistory.slice(-MEASUREMENT_HISTORY_DEPTH);
  const stamped = { ...measurement, history };
  state.measurements = state.measurements.filter(item => !(item.mode === measurement.mode && item.side === measurement.side));
  state.measurements.push(stamped);
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

// P2-3: was a delta computed across two readings captured under the SAME calibration/orientation
// context? Returns { ok, reasons[] }; ok is true when either side is missing (nothing to compare)
// or the contexts match. A mismatch (different zero/gain/pose/device-ref/fixture) means the two
// numbers are not directly comparable, so the UI warns rather than presenting a misleading delta.
function deltaContextFor(mode, leftSide, rightSide) {
  const left = measurementFor(mode, leftSide);
  const right = measurementFor(mode, rightSide);
  if (!left || !right) return { ok: true, reasons: [] };
  return deltaContextMatch(left, right);
}

// GEOMETRIC TOE: are both saved toe readings on a pair the SAME total-toe value stamped under the
// symmetry assumption (so their left-right delta is 0 by construction, not a measured difference)?
function symmetricToePair(leftSide, rightSide) {
  const left = measurementFor('toe', leftSide);
  const right = measurementFor('toe', rightSide);
  return !!left && !!right && left.toeSymmetryAssumed === true && right.toeSymmetryAssumed === true;
}

// GEOMETRIC TOE: the honest note for a toe L-R delta, shared by the saved-readings card AND the
// workflow-results grid so both surfaces describe the SAME data identically. A front/rear pair
// saved from a single TOTAL plate read holds the same value on both corners (the L-R split is a
// symmetry assumption), so the delta is 0 by construction — flag that rather than implying a
// measured per-wheel difference. A real per-wheel save (string-box) gives a genuine left-right
// delta referenced to the thrust line. `axle` selects the rear-specific thrust-angle wording.
function toeDeltaNote(leftSide, rightSide, delta, axle = 'front') {
  if (delta === null) {
    return `Use the geometric toe wizard to save ${leftSide} and ${rightSide}.`;
  }
  if (symmetricToePair(leftSide, rightSide)) {
    return `Δ is 0 by assumption — a TOTAL plate read cannot split ${leftSide} vs ${rightSide}.`;
  }
  return axle === 'rear'
    ? 'Per-wheel rear toe delta drives the thrust angle ((RL − RR) / 2).'
    : 'Per-wheel toe delta. Reference to the thrust line, not the centerline, for adjustment.';
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
    // P1-3a: a zero captured in the wrong orientation family is treated as not set here too.
    calibrationSet: modeIsZeroed(),
    levelPrepared: !!(state.calibrationMeta.level || hasSavedLevelReading()),
    // P0-4: physical-pose hint (non-blocking) instead of the old aspect-ratio orientation gate.
    orientationOk: state.poseOk,
    poseFamilyLabel: guide.orientation,
    settled: state.settled,
    baseline: precision.baseline,
    precision,
    modeLabel: MODE_LABELS[state.mode],
    guide,
    telemetryActive: state.sensorListenerAttached,
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

// P0/UX: turn the settle-block reason into a concrete, actionable line so the user knows WHY
// the reading will not settle (the old UI just said "hold steady" forever). Includes the live
// raw spread/σ so it doubles as a tuning readout against the SETTLED_* thresholds.
function settleBlockText() {
  switch (state.settleBlockedBy) {
    case 'no-reading': return 'No sensor reading for this mode.';
    case 'stream-stale': return 'Waiting for sensor data…';
    case 'collecting': return `Collecting samples (${state.rawSampleBuffer.length}/${MIN_SAMPLE_COUNT}).`;
    case 'motion': return 'Hold still — motion or vibration detected.';
    case 'spread': return `Too much movement (spread ${formatNumber(sampleRange())}°).`;
    case 'jitter': return `Too much jitter (σ ${formatNumber(sampleStdDev())}°).`;
    case 'drift': return 'Still drifting — let it settle.';
    case 'holding': return 'Holding steady…';
    default: return 'Settled average is ready.';
  }
}

function refreshReadiness() {
  const actionState = guideActionState();
  const summary = precisionSummary(state.mode, state.selectedSide);
  const saveReady = state.workflow === 'precision'
    ? summary.readyToSave && Number.isFinite(summary.finalValue)
    : state.settled;
  const saveReason = state.workflow === 'precision'
    ? precisionSaveReason(summary)
    : (state.readingMissing
        ? 'No reading available for this mode yet.'
        : (state.settled ? 'Settled average is ready.' : settleBlockText()));
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
  // P0-5 / P1-6: a missing reading or a lost stream takes priority in the stability chip.
  const streamLost = state.sensorListenerAttached && state.rawSampleBuffer.length && !streamIsHealthy();
  const stabilityValue = !state.sensorListenerAttached
    ? 'Paused'
    : (state.readingMissing
        ? 'No reading'
        : (streamLost
            ? 'Stream lost'
            : (!state.rawSampleBuffer.length ? 'Waiting' : (state.settled ? 'Settled' : 'Stabilizing'))));
  const stabilitySub = !state.sensorListenerAttached
    ? 'Telemetry stopped'
    : (state.readingMissing
        ? 'No gravity-derived angle for this mode'
        : (streamLost
            ? 'Sensor stream lost — hold and retry'
            : (!state.rawSampleBuffer.length
                ? 'Need motion samples'
                : `${state.rawSampleBuffer.length}/${SAMPLE_WINDOW} samples • spread ${formatNumber(range)}°`)));
  // P0-4: the orientation chip now reports PHYSICAL pose (in-pose vs wrong pose), derived from
  // gravity, rather than the screen aspect ratio. It is a hint, so a mismatch shows a cross
  // without blocking anything downstream.
  const orientationText = state.poseOk ? 'In pose ✓' : 'Wrong pose ✕';

  el('chip-stability').textContent = stabilityValue;
  el('chip-stability-sub').textContent = stabilitySub;
  // P1-4: confidence chip now leads with the honest +/- band in degrees.
  el('chip-confidence').textContent = Number.isFinite(state.toleranceDeg)
    ? formatTolerance(state.toleranceDeg)
    : `${state.confidence}%`;
  el('chip-confidence-sub').textContent = state.sensorListenerAttached
    ? `${state.confidence}% • σ ${formatNumber(stdDev)}° • raw live feed`
    : 'Start Measuring to refresh confidence';
  el('chip-orientation').textContent = orientationText;
  el('chip-orientation-sub').textContent = state.poseOk
    ? `${MODE_GUIDES[state.mode].orientation} pose for ${state.mode}`
    : `Hold the phone in ${MODE_GUIDES[state.mode].orientation} pose for ${state.mode}`;
  // P1-3a: a stored zero captured in the wrong orientation family is shown but flagged inactive.
  const zeroInactive = modeZeroOrientationMismatch();
  el('chip-calibration').textContent = calMeta ? formatSigned(calMeta.offset) : 'Not set';
  el('chip-calibration-sub').textContent = calMeta
    ? (zeroInactive
        ? `Ignored — zeroed in ${orientationLabel(calMeta.orientation)}, re-zero in ${MODE_GUIDES[state.mode].orientation}`
        : `Zeroed ${formatTime(calMeta.time)} • ${orientationLabel(calMeta.orientation)}`)
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
  // P0-2: toe has no gravity-derived reading, so surface the geometric-method banner and do not
  // dress the parked-at-0 needle/band as a real toe number.
  el('toe-explainer').classList.toggle('hidden-panel', state.mode !== 'toe');
  if (state.mode === 'toe') {
    // P0-2: do not show an averaged value, a +/- band, or a "hold steady" hint — there is no
    // sensor reading to settle. Both lines point at the geometric method instead.
    el('avg-display').textContent = 'No sensor toe value — measure geometrically';
    el('confidence-label').textContent = 'Toe: use string lines, turn plates, or rim offset';
    return;
  }
  // P1-4: surface the +/- band alongside the averaged value when it is estimable.
  const band = Number.isFinite(state.toleranceDeg) ? ` ${formatTolerance(state.toleranceDeg)}` : '';
  el('avg-display').textContent = `Avg ${formatSigned(avg)}${band} from ${state.sampleBuffer.length} sample${state.sampleBuffer.length === 1 ? '' : 's'}`;
  // P0-5 / P1-6: the confidence label states the blocking condition rather than a bare %.
  const streamLost = state.sensorListenerAttached && state.rawSampleBuffer.length && !streamIsHealthy();
  el('confidence-label').textContent = !state.sensorListenerAttached
    ? `Confidence ${state.confidence}% • Paused`
    : (state.readingMissing
        ? 'No reading • hold the phone steady'
        : (streamLost
            ? 'Sensor stream lost'
            : (state.settled
                ? `Confidence ${state.confidence}% ${formatTolerance(state.toleranceDeg)} • Settled`
                : `Confidence ${state.confidence}% • Live`)));
}

// GEOMETRIC TOE: sync a control's displayed value from state WITHOUT clobbering the field the user
// is actively editing (avoids cursor jumps on every keystroke). null/undefined renders as blank.
function syncToeField(id, value) {
  const node = el(id);
  if (node === document.activeElement) return;
  node.value = value === null || value === undefined ? '' : String(value);
}

// GEOMETRIC TOE: render the wizard. Visible only in toe mode (toggled here, not via .pane-hidden so
// the workflow stays the WORKFLOW for toe). The result comes from the pure orchestrator; the sensor
// settle/save gates never apply to toe.
function refreshToeWizard() {
  const wizard = el('toe-wizard');
  const isToe = state.mode === 'toe';
  wizard.classList.toggle('hidden-panel', !isToe);
  // Skip the (hidden) DOM work entirely when not in toe mode.
  if (!isToe) return;

  const w = state.toeWizard;
  const unitLabel = w.units === 'in' ? 'in' : 'mm';

  // Setup + read inputs.
  syncToeField('toe-diameter', w.diameter);
  syncToeField('toe-spec-diameter', w.specDiameter);
  syncToeField('toe-read-uncertainty', w.readUncertainty);
  el('toe-units').value = w.units;
  el('toe-spec-type').value = w.specType;
  el('toe-save-side').value = w.saveSide;
  syncToeField('toe-front-1', w.reads[0].front);
  syncToeField('toe-rear-1', w.reads[0].rear);
  syncToeField('toe-front-2', w.reads[1].front);
  syncToeField('toe-rear-2', w.reads[1].rear);

  // Method tabs + coaching copy.
  el('toe-method-plates').classList.toggle('active', w.method === 'plates');
  el('toe-method-plates').setAttribute('aria-selected', String(w.method === 'plates'));
  el('toe-method-tape').classList.toggle('active', w.method === 'tape');
  el('toe-method-tape').setAttribute('aria-selected', String(w.method === 'tape'));
  el('toe-method-hint').textContent = w.method === 'plates'
    ? `Plates + 2 tapes give TOTAL axle toe directly: measure the gap between the plates at the FRONT (F) and REAR (R) of the front tires over span D (${unitLabel}).`
    : `Tape-only fallback: mark two points on the front rim at equal height, measure the left–right gap at the REAR of both front wheels (R), roll forward so the SAME marks reach the FRONT, then re-measure (F). Span D is the mark height (${unitLabel}). Rolling the identical points cancels runout. ~0.15–0.3° total only.`;

  const result = toeWizardResult();
  const computed = result.ready;

  // Result chips.
  el('toe-total-value').textContent = computed ? formatSigned(result.totalToe) : '—';
  el('toe-total-sub').textContent = computed
    ? `${formatTolerance(result.toleranceDeg)} (95%) • toe-in positive • averaged over 2 read-pairs`
    : 'Enter both read-pairs to compute.';
  el('toe-perwheel-value').textContent = computed ? formatSigned(result.perWheelToe) : '—';
  el('toe-perwheel-sub').textContent = 'Assumes left–right symmetry — plates cannot split L vs R.';

  const linearForDisplay = w.specType === 'perWheel' ? result.perWheelLinear : result.totalLinear;
  el('toe-linear-value').textContent = computed && Number.isFinite(linearForDisplay)
    ? `${linearForDisplay >= 0 ? '+' : ''}${linearForDisplay.toFixed(3)} ${unitLabel}`
    : '—';
  el('toe-linear-sub').textContent = Number.isFinite(w.specDiameter) && w.specDiameter > 0
    ? `${w.specType === 'perWheel' ? 'Per-wheel' : 'Total'} linear at ${w.specDiameter} ${unitLabel} spec diameter.`
    : 'Enter the spec diameter to show the linear equivalent.';

  el('toe-runout-value').textContent = result.runout.ready
    ? `${formatNumber(result.runout.disagreement)}°`
    : '—';
  el('toe-runout-sub').textContent = !result.runout.ready
    ? 'Needs both read-pairs.'
    : (result.runout.exceeds
        ? `Exceeds ±${TOE_RUNOUT_THRESHOLD_DEG}° — runout/seating fault. Re-seat the rim and re-measure.`
        : `Within ±${TOE_RUNOUT_THRESHOLD_DEG}° — read-pairs agree.`);

  // Verdict + save gating. The save is driven by the wizard result, never state.settled.
  const verdictEl = el('toe-verdict');
  verdictEl.textContent = result.reason;
  verdictEl.className = `warning-text${computed ? (result.runout.exceeds ? ' warn' : ' good') : ''}`;

  const saveBtn = el('btn-save-toe');
  saveBtn.disabled = !computed;
  saveBtn.title = computed
    ? (result.runout.exceeds ? 'Runout check failed — re-seat and re-measure before saving.' : 'Save the computed toe to the selected side(s).')
    : result.reason;

  refreshToeStringBox(unitLabel);
}

// PRECISION string-box: render the per-wheel/thrust panel. Visible only in the PRECISION workflow
// (it is the precision toe path); the quick plates/tape result above always shows in toe mode. The
// result comes from the pure orchestrator — no sensors, no settle gate.
function refreshToeStringBox(unitLabel) {
  const section = el('toe-stringbox');
  const showStringBox = state.workflow === 'precision';
  section.classList.toggle('hidden-panel', !showStringBox);
  if (!showStringBox) return;

  const w = state.toeWizard;
  const result = toeStringBoxResult();

  // Per-corner inputs + computed per-wheel angle.
  SIDES.forEach(side => {
    syncToeField(`toe-sb-${side}-front`, w.stringBox[side].front);
    syncToeField(`toe-sb-${side}-rear`, w.stringBox[side].rear);
    const perWheel = result.perWheel[side];
    const linear = result.perWheelLinear[side];
    const resultEl = el(`toe-sb-${side}-result`);
    if (Number.isFinite(perWheel)) {
      const linearText = Number.isFinite(linear)
        ? ` (${linear >= 0 ? '+' : ''}${linear.toFixed(3)} ${unitLabel})`
        : '';
      resultEl.textContent = `Per-wheel ${formatSigned(perWheel)} ${formatTolerance(result.toleranceDeg)}${linearText}`;
    } else {
      resultEl.textContent = 'Enter front + rear string gaps';
    }
  });

  const ready = result.ready;
  const linearAt = Number.isFinite(w.specDiameter) && w.specDiameter > 0
    ? ` at ${w.specDiameter} ${unitLabel} spec`
    : '';

  el('toe-sb-total-front').textContent = ready ? formatSigned(result.totalFront) : '—';
  el('toe-sb-total-front-sub').textContent = ready
    ? `FL + FR per-wheel${linearAt ? ` • linear shown per corner${linearAt}` : ''}.`
    : 'FL + FR per-wheel.';
  el('toe-sb-total-rear').textContent = ready ? formatSigned(result.totalRear) : '—';
  el('toe-sb-total-rear-sub').textContent = 'RL + RR per-wheel.';
  el('toe-sb-thrust').textContent = ready ? formatSigned(result.thrust) : '—';
  el('toe-sb-thrust-sub').textContent = ready
    ? `(RL − RR) / 2 • ${result.thrust > 0 ? 'thrust line points LEFT' : result.thrust < 0 ? 'thrust line points RIGHT' : 'centered'}.`
    : '(RL − RR) / 2 • + points left.';
  el('toe-sb-front-ref').textContent = ready
    ? `${formatSigned(result.frontThrustReferenced.FL)} / ${formatSigned(result.frontThrustReferenced.FR)}`
    : '—';
  el('toe-sb-front-ref-sub').textContent = ready
    ? 'FL / FR corrected to the thrust line — adjust front toe to this, not the centerline.'
    : 'FL/FR corrected to the thrust line.';

  const verdict = el('toe-stringbox-verdict');
  verdict.textContent = result.reason;
  verdict.className = `warning-text${ready ? ' good' : ''}`;

  const saveBtn = el('btn-save-toe-stringbox');
  saveBtn.disabled = !ready;
  saveBtn.title = ready
    ? 'Save the four per-wheel toe values (no symmetry assumption) to FL/FR/RL/RR.'
    : result.reason;
}

function refreshCalibrationCard() {
  const meta = state.calibrationMeta[state.mode];
  // P1-3a: flag a stored zero that is being ignored because it was captured in the wrong
  // orientation family for this mode (so it is not silently applied to a mismatched pose).
  const zeroInactive = modeZeroOrientationMismatch();
  const valueText = meta
    ? `Offset ${formatSigned(meta.offset)} for ${MODE_LABELS[state.mode]}${zeroInactive ? ' (inactive)' : ''}`
    : 'None — tap Zero This Mode to calibrate';
  const historyText = meta
    ? (zeroInactive
        ? `Captured in ${orientationLabel(meta.orientation)} — ignored until re-zeroed in ${MODE_GUIDES[state.mode].orientation} pose.`
        : `Last set ${formatTime(meta.time)} in ${orientationLabel(meta.orientation)}. Stored locally per mode.`)
    : 'Saved locally per mode.';

  el('cal-value-text').textContent = valueText;
  el('cal-history-text').textContent = historyText;
  el('btn-reset-cal').disabled = !meta;

  // P2-1: surface the two-point scale gain and gate its capture/reset controls.
  const hasScale = modeHasScale();
  const gain = meta && Number.isFinite(meta.gain) ? meta.gain : 1;
  el('cal-scale-text').textContent = hasScale
    ? `Scale: ${gain.toFixed(3)}× from ${formatSigned(meta.gainReference)} reference${zeroInactive ? ' (inactive)' : ''}`
    : 'Scale: 1.00× (no scale reference)';
  // A scale only makes sense once the mode is zeroed in the right pose and a reading is settled.
  const scaleBtn = el('btn-set-scale');
  scaleBtn.disabled = state.mode === 'toe' || !state.sensorListenerAttached || !modeIsZeroed() || !state.settled;
  scaleBtn.title = state.mode === 'toe'
    ? 'Toe has no sensor reading — a scale reference does not apply.'
    : (!modeIsZeroed()
        ? 'Zero this mode in the correct pose before capturing a scale reference.'
        : (!state.sensorListenerAttached
            ? 'Tap Start Measuring before capturing a scale reference.'
            : (state.settled
                ? 'Hold the phone on a known reference angle, then enter it.'
                : 'Hold steady on the known angle until it settles, then capture the scale.')));
  el('btn-reset-scale').disabled = !hasScale;
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

  // P1-6: warn when the saved device reference is older than the staleness window.
  // P1-3b: the reference is informational only now (per-mode zeros are the live zero), so the
  // status/sub copy says "Recorded"/"Informational" rather than implying it shifts readings.
  const deviceStale = deviceProfileIsStale();
  el('device-profile-status').textContent = state.deviceProfile ? (deviceStale ? 'Stale' : 'Recorded') : 'Not set';
  el('device-profile-sub').textContent = state.deviceProfile
    ? (deviceStale
        ? `Reference set ${formatTime(state.deviceProfile.time)} is stale — re-capture to refresh the record.`
        : `Informational • ${state.deviceProfile.label} • β ${formatSigned(state.deviceProfile.axisBias.beta)} • γ ${formatSigned(state.deviceProfile.axisBias.gamma)}`)
    : 'Capture on a trusted flat or vertical reference (informational).';
  el('fixture-status').textContent = fixture ? fixture.name : 'Not set';
  el('fixture-status-sub').textContent = fixture
    ? `${fixture.reversible ? 'Reversible' : 'Single orientation'} • ${fixture.notes || 'No notes'}`
    : 'Use a rigid, reversible jig if possible.';
  el('baseline-status').textContent = baseline.label;
  // P2-2: flag a non-coplanar baseline (a corner off the fitted plane) with the worst residual so
  // a bad/mis-placed datum is visible rather than silently averaged into the deltas.
  el('baseline-status-sub').textContent = baseline.complete
    ? (baseline.planeCoplanar === false
        ? `Non-coplanar datum — worst corner off plane ${formatSigned(baseline.planeMaxResidual || 0)}. Re-capture the outlier.`
        : `Front ${formatSigned(baseline.frontRearDelta || 0)} • Left ${formatSigned(baseline.leftRightDelta || 0)}`)
    : `${baseline.completedSides}/4 points captured in Level mode.`;
  el('precision-trust-status').textContent = summary.verdict;
  // P1-4 / P1-5: surface n and the +/- band next to the verdict.
  const trustBand = Number.isFinite(summary.toleranceDeg) ? ` • ${formatTolerance(summary.toleranceDeg)}` : '';
  el('precision-trust-sub').textContent = `Repeatability ${summary.repeatabilityScore}% • n=${summary.n}${trustBand} • ${summary.needsReverse ? 'Reverse required' : 'Forward-only fixture'}`;
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
  // P1-5: show captures against the displayed targets so n vs target is explicit.
  el('precision-capture-counts').textContent = `${summary.forward?.count || 0}/${PRECISION_CONSTANTS.FORWARD_CAPTURE_TARGET} / ${summary.reverse?.count || 0}/${PRECISION_CONSTANTS.REVERSE_CAPTURE_TARGET}`;
  el('precision-capture-sub').textContent = summary.needsReverse
    ? 'Forward count first, reversed count second.'
    : 'Forward count shown first; reverse is optional for this fixture.';
  el('precision-repeatability-value').textContent = `${summary.repeatabilityScore}%`;
  el('precision-repeatability-sub').textContent = summary.forward
    ? `Forward σ ${formatNumber(summary.forward.stdDev)}°${summary.reverse ? ` • Reverse σ ${formatNumber(summary.reverse.stdDev)}°` : ''}`
    : 'Settled spread and repeated agreement drive this score.';
  el('precision-bias-value').textContent = summary.reversalBias === null ? 'Pending' : formatSigned(summary.reversalBias);
  // P1-1: flag a re-zero between flips here since it lives on the forward/reverse relationship.
  el('precision-bias-sub').textContent = summary.offsetConflict
    ? 'Forward and reversed used different zeros — re-capture without re-zeroing.'
    : (summary.reversalBias === null
        ? 'Capture a reversed set to estimate mounting bias.'
        : `Baseline compensation ${formatSigned(summary.baselineCompensation)}`);
  el('precision-baseline-plane').textContent = baseline.complete
    ? `${formatSigned(baseline.leftRightDelta || 0)} L-R`
    : `${baseline.completedSides}/4 ready`;
  el('precision-baseline-plane-sub').textContent = baseline.complete
    ? `Front-Rear ${formatSigned(baseline.frontRearDelta || 0)} • ${baseline.label}`
    : 'Front/rear and left/right averages from Level mode.';
  // P1-4 / Stage 5: the precision final value reads "X.XX° ± Y.YY° (95%)".
  el('precision-final-value').textContent = Number.isFinite(summary.finalValue) ? formatValueWithBand(summary.finalValue, summary.toleranceDeg) : '—';
  // P0-7: a top verdict only earns adjustment-grade trust once a flip self-test has confirmed
  // trueness; otherwise spell out that repeatability alone is not trueness.
  const selfTestNote = selfTestPassedRecently()
    ? ' • flip self-test passed'
    : ' • run flip self-test to confirm trueness';
  el('precision-final-sub').textContent = `${summary.verdict}${selfTestNote}${Number.isFinite(summary.reversalCorrectedValue) ? ` • corrected ${formatSigned(summary.reversalCorrectedValue)}` : ''}`;
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
  refreshSelfTestCard();
}

// P0-7: render the guided flip self-test status. Surfaces reading A pending, the last pass/fail
// with its residual bias and asymmetry, and whether the pass is recent enough to back trust.
function refreshSelfTestCard() {
  const btn = el('btn-self-test');
  const result = state.selfTest.result;
  const pendingA = state.selfTest.mode === state.mode && state.selfTest.firstReading !== null;
  const toeBlocked = state.mode === 'toe';

  btn.disabled = !state.sensorListenerAttached || toeBlocked;
  btn.textContent = pendingA ? 'Capture reading B (after flip)' : 'Capture reading A';
  btn.title = toeBlocked
    ? 'Toe has no sensor reading — the flip self-test does not apply.'
    : (!state.sensorListenerAttached
        ? 'Tap Start Measuring before running the self-test.'
        : (pendingA ? 'Flip the phone 180° about the axis, settle, then capture reading B.' : 'Capture the first settled reading.'));

  let status;
  let sub;
  if (toeBlocked) {
    status = 'N/A for toe';
    sub = 'Toe is geometric — no sensor reading to flip-test.';
  } else if (pendingA) {
    status = 'Reading A captured';
    sub = `A = ${formatSigned(state.selfTest.firstReading)} • flip 180°, settle, capture B.`;
  } else if (result && result.mode === state.mode) {
    const fresh = selfTestPassedRecently();
    status = result.passed ? (fresh ? 'Passed' : 'Passed (stale)') : 'Failed';
    sub = `A ${formatSigned(result.firstReading)} / B ${formatSigned(result.secondReading)} • asymmetry ${formatNumber(result.asymmetry)}° • ${formatTime(result.time)}`;
  } else {
    status = 'Not run';
    sub = `Run a flip self-test for ${MODE_LABELS[state.mode]} before trusting a save.`;
  }
  el('self-test-status').textContent = status;
  el('self-test-sub').textContent = sub;
  el('self-test-bias').textContent = result && result.mode === state.mode && Number.isFinite(result.residualBias)
    ? formatSigned(result.residualBias)
    : '—';
  el('self-test-bias-sub').textContent = result && result.mode === state.mode && Number.isFinite(result.asymmetry)
    ? `Asymmetry |a + b| = ${formatNumber(result.asymmetry)}° (tolerance ±${result.tolerance}°)`
    : 'Asymmetry |a + b| should be small for a true sensor.';
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

// GEOMETRIC TOE: the linear equivalent at the quoted spec diameter, paired with the diameter it
// assumes (never show a linear toe without its diameter). Returns '' when no linear value is stored.
function toeLinearNote(reading) {
  if (!Number.isFinite(reading.toeLinear)) return '';
  const unit = reading.toeUnits === 'in' ? 'in' : 'mm';
  const sign = reading.toeLinear >= 0 ? '+' : '';
  const at = Number.isFinite(reading.toeSpecDiameter) && reading.toeSpecDiameter > 0
    ? ` @${reading.toeSpecDiameter}${unit}`
    : '';
  return `${sign}${reading.toeLinear.toFixed(2)}${unit}${at}`;
}

// Saved-readings meta line, honest about how the value was obtained (sensor vs geometric toe).
function savedNoteForReading(reading) {
  const parts = [`Saved ${formatTime(reading.time)}`];
  if (reading.workflow === 'geometric') {
    parts.push(`geometric ${reading.toeMethod || 'toe'}`);
    // Per-wheel vs total + the linear equivalent at its quoted diameter, surfaced everywhere toe shows.
    const linear = toeLinearNote(reading);
    if (linear) parts.push(linear);
    if (reading.toeMethod === 'string-box') {
      if (Number.isFinite(reading.toeThrust)) parts.push(`thrust ${formatSigned(reading.toeThrust)}`);
      parts.push('per-wheel (L/R split)');
    } else {
      if (reading.toeSymmetryAssumed) parts.push('total/2 symmetry');
      parts.push(reading.toeRunoutFault
        ? `runout fault Δ${formatNumber(reading.toeRunoutDisagreement || 0)}°`
        : 'runout ok');
    }
  } else if (reading.workflow === 'precision') {
    parts.push(`precision ${reading.repeatabilityScore || 0}%`);
    parts.push(reading.trustVerdict || `${reading.samples} samples`);
  } else {
    parts.push(`${reading.confidence}% confidence`);
    parts.push(`${reading.samples} samples`);
  }
  return parts.filter(Boolean).join(' • ');
}

// Short per-corner note for the workflow results grid, honest about how the value was obtained.
function specNoteForReading(reading) {
  if (reading.workflow === 'geometric') {
    if (reading.toeRunoutFault) return 'Geometric • runout fault';
    // Per-wheel toe values carry their linear equivalent (with the diameter it assumes) inline.
    const linear = toeLinearNote(reading);
    const base = reading.trustVerdict || 'Geometric toe';
    return linear ? `${base} • ${linear}` : base;
  }
  if (reading.workflow === 'precision') {
    return reading.trustVerdict || 'Precision saved';
  }
  return `${reading.confidence}% confidence`;
}

function refreshWorkflowResults() {
  const readings = SIDES.map(side => measurementFor(state.mode, side));
  const savedCount = readings.filter(Boolean).length;
  const modeLabel = MODE_LABELS[state.mode];
  const complete = savedCount === SIDES.length;
  const baseline = baselineSummary();
  const grid = el('workflow-spec-grid');

  el('workflow-result-title').textContent = complete
    ? `Final ${modeLabel} specs ready`
    : `${modeLabel} workflow`;
  el('workflow-result-summary').textContent = complete
    ? 'All four corners are saved. Review calculated side values and deltas before adjusting.'
    : `Saved ${savedCount}/4 corners. Follow the next workflow action and collect stable data before saving.`;

  grid.textContent = '';
  SIDES.forEach((side, index) => {
    const reading = readings[index];
    const item = buildElement('div', `spec-item${reading ? ' ready' : ''}`);
    item.appendChild(buildElement('span', 'spec-label', side));
    item.appendChild(buildElement('strong', 'spec-value', reading ? formatSigned(reading.value) : 'Pending'));
    item.appendChild(buildElement('small', 'spec-note', reading
      ? specNoteForReading(reading)
      : 'Collect when guided'));
    grid.appendChild(item);
  });

  const frontDelta = deltaFor(state.mode, 'FL', 'FR');
  const rearDelta = deltaFor(state.mode, 'RL', 'RR');
  // GEOMETRIC TOE: in toe mode reuse the shared toeDeltaNote so the grid flags a plates-only pair
  // as "Δ is 0 by assumption" instead of the misleading generic "FL − FR" — matching the
  // saved-readings card exactly. Other modes keep the literal subtraction note.
  const isToe = state.mode === 'toe';
  const frontDeltaNote = frontDelta === null
    ? 'Needs FL + FR'
    : (isToe ? toeDeltaNote('FL', 'FR', frontDelta, 'front') : 'FL − FR');
  const rearDeltaNote = rearDelta === null
    ? 'Needs RL + RR'
    : (isToe ? toeDeltaNote('RL', 'RR', rearDelta, 'rear') : 'RL − RR');
  [
    ['Front Δ', frontDelta === null ? 'Pending' : formatSigned(frontDelta), frontDeltaNote],
    ['Rear Δ', rearDelta === null ? 'Pending' : formatSigned(rearDelta), rearDeltaNote],
    ['Baseline', baseline.complete ? baseline.label : `${baseline.completedSides}/4`, state.workflow === 'precision' ? 'Level plane quality' : 'Use Level first'],
  ].forEach(([label, value, note]) => {
    const item = buildElement('div', `spec-item${value !== 'Pending' ? ' ready' : ''}`);
    item.appendChild(buildElement('span', 'spec-label', label));
    item.appendChild(buildElement('strong', 'spec-value', value));
    item.appendChild(buildElement('small', 'spec-note', note));
    grid.appendChild(item);
  });
}

function refreshTelemetryVisibility() {
  document.querySelector('details.advanced-card')?.classList.toggle('hidden-panel', !state.sensorListenerAttached);
}

function refreshSavedReadings() {
  document.querySelectorAll('.side-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.side === state.selectedSide);
    button.setAttribute('aria-selected', String(button.dataset.side === state.selectedSide));
  });

  const current = measurementFor(state.mode, state.selectedSide);
  el('saved-side-title').textContent = `${MODE_LABELS[state.mode]} · ${state.selectedSide}`;
  // P1-4 / Stage 5: the saved-side box leads with the value AND its 95% band as one number.
  el('saved-side-value').textContent = current ? formatValueWithBand(current.value, current.toleranceDeg) : 'No saved reading';
  el('saved-side-note').textContent = current
    ? savedNoteForReading(current)
    : (state.mode === 'toe'
        ? 'Enter the geometric toe wizard above, then tap Save toe reading.'
        : `Hold the phone steady until it settles, then tap ${state.workflow === 'precision' ? 'Save Precision' : 'Save Avg'}.`);

  const frontDelta = deltaFor(state.mode, 'FL', 'FR');
  const rearDelta = deltaFor(state.mode, 'RL', 'RR');
  el('front-delta').textContent = frontDelta === null ? '—' : formatSigned(frontDelta);
  el('rear-delta').textContent = rearDelta === null ? '—' : formatSigned(rearDelta);
  if (state.mode === 'toe') {
    // GEOMETRIC TOE: toe values come from the wizard (geometric, sensor-free). The honest L-R
    // delta note (symmetry-assumed vs real per-wheel) is shared with the workflow-results grid
    // via toeDeltaNote so both surfaces describe the same save identically.
    el('front-delta-note').textContent = toeDeltaNote('FL', 'FR', frontDelta, 'front');
    el('rear-delta-note').textContent = toeDeltaNote('RL', 'RR', rearDelta, 'rear');
  } else {
    // P2-3: warn when a delta is computed across mismatched calibration/orientation contexts.
    const frontContext = deltaContextFor(state.mode, 'FL', 'FR');
    const rearContext = deltaContextFor(state.mode, 'RL', 'RR');
    el('front-delta-note').textContent = frontDelta === null
      ? 'Save both front sides for this mode.'
      : (frontContext.ok
          ? 'A negative delta means FL is smaller than FR.'
          : `Delta context mismatch (${frontContext.reasons.join(', ')}) — re-capture FL/FR under one calibration.`);
    el('rear-delta-note').textContent = rearDelta === null
      ? 'Save both rear sides for this mode.'
      : (rearContext.ok
          ? 'A negative delta means RL is smaller than RR.'
          : `Delta context mismatch (${rearContext.reasons.join(', ')}) — re-capture RL/RR under one calibration.`);
  }

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
    if (item.workflow === 'geometric') {
      // GEOMETRIC TOE: surface the method, linear equivalent, and the basis (per-wheel split or
      // total/2 symmetry + runout), not a fake %.
      metaParts.push(`geometric ${item.toeMethod || 'toe'}`);
      const linear = toeLinearNote(item);
      if (linear) metaParts.push(linear);
      if (item.toeMethod === 'string-box') {
        if (Number.isFinite(item.toeThrust)) metaParts.push(`thrust ${formatSigned(item.toeThrust)}`);
        metaParts.push('per-wheel (L/R split)');
      } else {
        if (item.toeSymmetryAssumed) metaParts.push('total/2 symmetry');
        metaParts.push(item.toeRunoutFault
          ? `runout fault Δ${formatNumber(item.toeRunoutDisagreement || 0)}°`
          : 'runout ok');
      }
    } else if (item.workflow === 'precision') {
      metaParts.push(`${item.repeatabilityScore || 0}% repeatability`);
      // P1-5: surface n alongside the verdict so trust is tied to capture count.
      if (item.trustVerdict) metaParts.push(`${item.trustVerdict} (n=${item.captureCount || item.samples || 0})`);
      if (item.reversalBias !== null && item.reversalBias !== undefined) metaParts.push(`bias ${formatSigned(item.reversalBias)}`);
    } else {
      metaParts.push(`${item.confidence}% confidence`);
      metaParts.push(`${item.samples} samples`);
    }
    const meta = buildElement('div', 'saved-meta', metaParts.join(' • '));
    // P1-4 / Stage 5: the saved value carries its 95% band inline ("X.XX° ± Y.YY° (95%)").
    const value = buildElement('strong', 'saved-value', formatValueWithBand(item.value, item.toleranceDeg));

    metaWrap.appendChild(label);
    metaWrap.appendChild(meta);
    row.appendChild(metaWrap);
    row.appendChild(value);
    list.appendChild(row);
  });
}

// P2-4: human-readable heading-trust status for the advanced panel. Raw alpha is never a yaw
// reference; only a trusted absolute compass heading is usable, and indoor distortion is called out.
function headingStatusText() {
  if (state.headingTrusted && Number.isFinite(state.heading)) {
    const acc = Number.isFinite(state.headingAccuracy) ? ` ±${formatNumber(state.headingAccuracy)}°` : '';
    return `${formatNumber(state.heading)}°${acc} (trusted)`;
  }
  if (state.headingReason === 'poor-accuracy') return 'Not trusted — indoor magnetic distortion';
  if (state.headingReason === 'no-heading') return 'Not trusted — absolute alpha, no compass';
  if (state.headingReason === 'relative') return 'Not trusted — heading is relative';
  return 'Not trusted — no heading';
}

function refreshAdvanced() {
  el('raw-alpha').textContent = `${formatNumber(state.alpha)}°`;
  el('raw-beta').textContent = `${formatNumber(state.beta)}°`;
  el('raw-gamma').textContent = `${formatNumber(state.gamma)}°`;
  el('sample-spread').textContent = `${formatNumber(sampleRange())}° range • ${formatNumber(sampleStdDev())}° σ`;
  // P2-4: surface compass/heading trust so squareness/toe work never silently uses raw alpha.
  el('heading-trust').textContent = headingStatusText();

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
  updateOrientationPose();
  refreshWorkflowMode();
  refreshGuide();
  refreshReadiness();
  refreshGauge();
  refreshToeWizard();
  refreshStatus();
  refreshCalibrationCard();
  refreshPrecisionCard();
  refreshLockButton();
  refreshSavedReadings();
  refreshAdvanced();
  refreshWorkflowResults();
  refreshTelemetryVisibility();
  refreshSaveConfirmation();
  refreshAriaState();
}

function refreshLiveUI() {
  updateOrientationPose();
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
      runFlipSelfTest: () => runFlipSelfTest(),
      resetFlipSelfTest: () => resetFlipSelfTest(),
      savePrecisionMeasurement: () => savePrecisionMeasurement(),
      calibrate: () => calibrate(),
      calibrateScale: () => calibrateScale(),
      resetScaleCalibration: () => resetScaleCalibration(),
      saveMeasurement: () => saveMeasurement(),
      resetCalibration: () => resetCalibration(),
      selectSide: () => selectSide(arg),
      backFromInstructions: () => backFromInstructions(),
      // GEOMETRIC TOE wizard actions (no inline onclick; routed through delegation like the rest).
      setToeMethod: () => setToeMethod(arg),
      saveToeMeasurement: () => saveToeMeasurement(),
      resetToeWizard: () => resetToeWizard(),
      // PRECISION string-box actions.
      saveToeStringBox: () => saveToeStringBox(),
      resetToeStringBox: () => resetToeStringBox(),
    };
    const handler = handlers[action];
    if (handler) handler();
  });

  const fixtureSelect = el('fixture-select');
  fixtureSelect.addEventListener('change', event => {
    selectFixture(event.target.value);
  });

  // GEOMETRIC TOE: number inputs and selects emit input/change, not click, so route any control
  // tagged data-action="toeInput" through setToeInput. `input` covers typing; `change` covers the
  // <select> dropdowns. Delegated on document so the (hidden) toe pane needs no per-element wiring.
  const handleToeInput = event => {
    const trigger = event.target.closest('[data-action="toeInput"]');
    if (trigger) {
      setToeInput(trigger.dataset.arg, event.target.value);
      return;
    }
    // PRECISION string-box per-corner gaps share the same delegated input/change path.
    const stringTrigger = event.target.closest('[data-action="toeStringInput"]');
    if (stringTrigger) setToeStringInput(stringTrigger.dataset.arg, event.target.value);
  };
  document.addEventListener('input', handleToeInput);
  document.addEventListener('change', handleToeInput);

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
