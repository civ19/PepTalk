// Demo UI for the Presage module. Everything SmartSpectra-specific lives behind
// createPresageTracker(); this file only uses the public interface.

import './styles.css';
import {
  classifyGaze,
  createPresageTracker,
  MIN_VITALS_CONFIDENCE,
  type GazeDirection,
  type LandmarksReading,
  type PresageError,
  type PresageSample,
  type TrackerStatus,
  type ValidationEvent,
} from '../../presage';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
};

const ui = {
  status: $('status'),
  timer: $('timer'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  errors: $('errors'),
  hint: $('hint'),
  video: $<HTMLVideoElement>('video'),
  overlay: $<HTMLCanvasElement>('overlay'),
  placeholder: $('placeholder'),
  pulse: $('pulse'),
  pulseConf: $('pulse-conf'),
  breathing: $('breathing'),
  breathingConf: $('breathing-conf'),
  hrv: $('hrv'),
  hrvConf: $('hrv-conf'),
  blinkDot: $('blink-dot'),
  blinkCount: $('blink-count'),
  talkDot: $('talk-dot'),
  gazeTile: $('gaze-tile'),
  eyeContact: $('eye-contact'),
  gazeDir: $('gaze-dir'),
  expression: $('expression'),
  expressionConf: $('expression-conf'),
  warnings: $('warnings'),
  summaryBox: $<HTMLDetailsElement>('summary-box'),
  summaryPath: $('summary-path'),
  summaryJson: $('summary-json'),
};

// ---------------------------------------------------------------------------
// Errors: shown as banners, never swallowed.

function showError(e: PresageError): void {
  console.error('[presage error]', e);
  const text = `${e.name} (${String(e.code)}): ${e.message}${e.retryable ? ' (retryable)' : ''}`;
  // Collapse repeats of the same error into one banner with a counter.
  for (const el of ui.errors.querySelectorAll<HTMLElement>('.banner')) {
    if (el.dataset['text'] === text) {
      const n = Number(el.dataset['count'] ?? '1') + 1;
      el.dataset['count'] = String(n);
      const counter = el.querySelector('.repeat');
      if (counter) counter.textContent = `×${n}`;
      return;
    }
  }
  const banner = document.createElement('div');
  banner.className = 'banner error';
  banner.dataset['text'] = text;
  banner.innerHTML = '<span class="msg"></span><span class="repeat"></span><button type="button" aria-label="Dismiss">×</button>';
  const msg = banner.querySelector('.msg');
  if (msg) msg.textContent = text;
  banner.querySelector('button')?.addEventListener('click', () => banner.remove());
  ui.errors.append(banner);
}

const host = window.presageHost;
if (!host) {
  showError({ code: 'NO_BRIDGE', name: 'PreloadMissing', message: 'window.presageHost is unavailable: the preload script did not load.', retryable: false });
}

const tracker = createPresageTracker({
  apiKey: () => (host ? host.getApiKey() : Promise.reject(new Error('preload bridge unavailable'))),
  ...(host ? { persist: (summary) => host.saveSession(summary) } : {}),
});

// ---------------------------------------------------------------------------
// Status + timer

const STATUS_LABEL: Record<TrackerStatus, string> = {
  idle: 'Idle',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Saving…',
  error: 'Error',
};

let sessionStartedAt = 0;
let timerHandle: number | null = null;

function renderTimer(): void {
  const s = Math.floor((Date.now() - sessionStartedAt) / 1000);
  ui.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

tracker.onStatus((s) => {
  ui.status.textContent = STATUS_LABEL[s];
  ui.status.dataset['status'] = s;
  ui.start.disabled = tracker.sessionActive || s === 'starting' || s === 'stopping';
  // Stop stays available after an SDK error so the camera can be released and the partial session saved.
  ui.stop.disabled = !tracker.sessionActive || s === 'stopping';
  if (s === 'error' && tracker.sessionActive) {
    ui.hint.dataset['kind'] = 'issue';
    ui.hint.textContent = 'Measurement stopped working. Press Stop & save to release the camera and keep what was recorded.';
  }
});

// ---------------------------------------------------------------------------
// Video + landmark overlay

const ctx = ui.overlay.getContext('2d');
let landmarkClearTimer: number | null = null;

tracker.onStream((stream) => {
  ui.video.srcObject = stream;
  ui.placeholder.hidden = stream !== null;
  if (stream) void ui.video.play().catch(() => undefined);
  else clearOverlay();
});

ui.video.addEventListener('loadedmetadata', () => {
  ui.overlay.width = ui.video.videoWidth;
  ui.overlay.height = ui.video.videoHeight;
  ui.video.parentElement?.style.setProperty('aspect-ratio', `${ui.video.videoWidth} / ${ui.video.videoHeight}`);
});

function clearOverlay(): void {
  ctx?.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
}

// MediaPipe iris points (468-472 and 473-477), highlighted on top of the mesh.
const IRIS_FIRST = 468;

function drawLandmarks(lm: LandmarksReading, gaze: GazeDirection | null): void {
  if (!ctx || lm.points.length === 0) return;
  const w = ui.overlay.width;
  const h = ui.overlay.height;
  // Docs: landmarks are pixel coordinates in the processed frame. Fall back to
  // normalized [0,1] coordinates if that's what arrives.
  const normalized = lm.points.every((p) => p.x <= 1.5 && p.y <= 1.5);
  const sx = normalized ? w : 1;
  const sy = normalized ? h : 1;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = lm.stable ? 'rgba(94, 234, 212, 0.9)' : 'rgba(250, 204, 21, 0.9)';
  const r = Math.max(1.2, w / 640);
  for (const p of lm.points) {
    ctx.beginPath();
    ctx.arc(p.x * sx, p.y * sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (gaze !== null) {
    ctx.fillStyle = gaze === 'camera' ? 'rgba(52, 211, 153, 1)' : 'rgba(251, 146, 60, 1)';
    for (const p of lm.points.slice(IRIS_FIRST)) {
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (landmarkClearTimer !== null) clearTimeout(landmarkClearTimer);
  landmarkClearTimer = window.setTimeout(clearOverlay, 500);
}

// ---------------------------------------------------------------------------
// Live panel

let blinkCount = 0;
let lastBlink = false;
let talkingNow = false;
// Eye contact: share of gaze readings on camera, plus a smoothed live direction
// so the label doesn't flicker on landmark jitter.
const GAZE_SMOOTHING = 0.3;
let gazeReadings = 0;
let gazeOnCamera = 0;
let smoothGaze: { h: number; v: number } | null = null;
let liveGaze: GazeDirection | null = null;

const GAZE_LABEL: Record<GazeDirection, string> = {
  camera: 'looking at the camera',
  left: 'looking to your left',
  right: 'looking to your right',
  up: 'looking up',
  down: 'looking down',
};

function setReading(valueEl: HTMLElement, subEl: HTMLElement, value: number, confidence: number, min: number, digits = 0): void {
  valueEl.textContent = value.toFixed(digits);
  const low = confidence < min;
  valueEl.parentElement?.classList.toggle('low', low);
  subEl.textContent = low ? `low confidence (${Math.round(confidence)}%)` : `confidence ${Math.round(confidence)}%`;
}

function onSample(s: PresageSample): void {
  const pulse = s.pulse.at(-1);
  if (pulse) setReading(ui.pulse, ui.pulseConf, pulse.value, pulse.confidence, MIN_VITALS_CONFIDENCE.pulse);

  const hrv = s.hrv.at(-1);
  if (hrv) setReading(ui.hrv, ui.hrvConf, hrv.rmssdMs, hrv.confidence, MIN_VITALS_CONFIDENCE.hrv);

  for (const t of s.talking) talkingNow = t.detected;
  ui.talkDot.classList.toggle('on', talkingNow);

  const br = s.breathing.at(-1);
  if (br) setReading(ui.breathing, ui.breathingConf, br.value, br.confidence, MIN_VITALS_CONFIDENCE.breathing);
  if (talkingNow) ui.breathingConf.textContent = 'unreliable while talking';

  for (const b of s.blinking) {
    if (b.detected && !lastBlink) {
      blinkCount++;
      ui.blinkDot.classList.add('on');
      window.setTimeout(() => ui.blinkDot.classList.remove('on'), 180);
    }
    lastBlink = b.detected;
  }
  ui.blinkCount.textContent = String(blinkCount);

  const expr = s.expressions.at(-1);
  if (expr?.top) {
    ui.expression.textContent = expr.top;
    ui.expressionConf.textContent = `${Math.round(expr.topConfidence)}%`;
  }

  if (s.gaze) {
    gazeReadings++;
    if (s.gaze.direction === 'camera') gazeOnCamera++;
    smoothGaze = smoothGaze
      ? { h: smoothGaze.h + GAZE_SMOOTHING * (s.gaze.h - smoothGaze.h), v: smoothGaze.v + GAZE_SMOOTHING * (s.gaze.v - smoothGaze.v) }
      : { h: s.gaze.h, v: s.gaze.v };
    liveGaze = classifyGaze(smoothGaze.h, smoothGaze.v);
    ui.eyeContact.textContent = String(Math.round((gazeOnCamera / gazeReadings) * 100));
    ui.gazeDir.textContent = GAZE_LABEL[liveGaze];
    ui.gazeTile.dataset['gaze'] = liveGaze === 'camera' ? 'camera' : 'away';
  }

  if (s.landmarks) drawLandmarks(s.landmarks, liveGaze);
}

tracker.onSample(onSample);

// ---------------------------------------------------------------------------
// Validation hint

tracker.onValidation((v: ValidationEvent) => {
  ui.hint.dataset['kind'] = v.ok ? 'ok' : v.name === 'CameraTuning' ? 'tuning' : 'issue';
  if (v.ok) {
    ui.hint.textContent = 'Looking good. Keep your face centered and still.';
    return;
  }
  ui.hint.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = v.advice;
  ui.hint.append(strong);
  if (v.hint && v.hint.toLowerCase() !== v.advice.toLowerCase()) ui.hint.append(` · ${v.hint}`);
});

tracker.onError(showError);

tracker.onWarning((w) => {
  const el = document.createElement('div');
  el.className = `banner ${w.kind === 'metric-group-empty' ? 'warn' : 'info'}`;
  el.textContent = w.message;
  ui.warnings.append(el);
});

// ---------------------------------------------------------------------------
// Session controls

function resetPanel(): void {
  for (const el of [ui.pulse, ui.breathing, ui.hrv, ui.expression, ui.eyeContact]) {
    el.textContent = '--';
    el.parentElement?.classList.remove('low');
  }
  ui.pulseConf.textContent = 'waiting for signal (~12 s)';
  ui.breathingConf.textContent = 'needs ~30 s of signal';
  ui.hrvConf.textContent = 'needs ~60 s of signal';
  ui.expressionConf.textContent = '';
  blinkCount = 0;
  lastBlink = false;
  talkingNow = false;
  gazeReadings = 0;
  gazeOnCamera = 0;
  smoothGaze = null;
  liveGaze = null;
  ui.gazeDir.textContent = 'waiting for face';
  delete ui.gazeTile.dataset['gaze'];
  ui.blinkCount.textContent = '0';
  ui.talkDot.classList.remove('on');
  ui.warnings.replaceChildren();
  ui.errors.replaceChildren();
}

ui.start.addEventListener('click', () => {
  resetPanel();
  ui.hint.dataset['kind'] = 'tuning';
  ui.hint.textContent = 'Starting camera…';
  sessionStartedAt = Date.now();
  renderTimer();
  timerHandle = window.setInterval(renderTimer, 500);
  tracker.startSession().catch(() => {
    // Already surfaced through onError.
    if (timerHandle !== null) clearInterval(timerHandle);
    ui.hint.dataset['kind'] = 'issue';
    ui.hint.textContent = 'Could not start. See the error above.';
  });
});

ui.stop.addEventListener('click', () => {
  if (timerHandle !== null) clearInterval(timerHandle);
  tracker
    .stopSession()
    .then(({ summary, savedTo }) => {
      ui.hint.dataset['kind'] = 'idle';
      ui.hint.textContent = 'Session saved. Press Start session to go again.';
      const { series: _series, ...overview } = summary;
      ui.summaryJson.textContent = JSON.stringify(overview, null, 2);
      ui.summaryPath.textContent = savedTo ? `Saved to ${savedTo}` : 'Not saved (see errors).';
      ui.summaryBox.hidden = false;
      ui.summaryBox.open = true;
    })
    .catch((err: unknown) => {
      showError({ code: 'STOP_FAILED', name: 'StopFailed', message: err instanceof Error ? err.message : String(err), retryable: false });
    });
});

// Window close: main waits for this, so the SDK is stopped (and the partial
// session saved) before the app exits.
host?.onShutdownRequest(async () => {
  await tracker.shutdown();
});
// Reloads (e.g. dev HMR) skip the close handshake; release synchronously.
window.addEventListener('beforeunload', () => tracker.dispose());
