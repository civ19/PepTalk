// Demo UI for the Presage module. Everything SmartSpectra-specific lives behind
// createPresageTracker(); this file only uses the public interface.

import './styles.css';
import {
  classifyGaze,
  createPresageTracker,
  MIN_VITALS_CONFIDENCE,
  PayloadDump,
  type DebugConfig,
  type GazeDirection,
  type LandmarksReading,
  type PresageError,
  type PresageSample,
  type TrackerStatus,
  type ValidationEvent,
} from '../../presage';
import { SessionCapture } from '../../capture/sessionCapture';
import type { UploadState } from '../../shared/session-types';
import { formatTime, setupReview } from './review';

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
  captureBox: $('capture-box'),
  captureStatus: $('capture-status'),
  uploadStatus: $('upload-status'),
  retryUpload: $<HTMLButtonElement>('retry-upload'),
  flagsStatus: $('flags-status'),
  reviewLast: $<HTMLButtonElement>('review-last'),
  flagMoment: $<HTMLButtonElement>('flag-moment'),
  flagNote: $('flag-note'),
  tabRecord: $<HTMLButtonElement>('tab-record'),
  tabReview: $<HTMLButtonElement>('tab-review'),
  recordView: $('record-view'),
  reviewView: $('review-view'),
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

// Debug payload dump (npm run debug:dump). Created once the main process says it's on.
let dump: PayloadDump | null = null;
let debugConfig: DebugConfig = { dumpSeconds: null, autorun: false };

const tracker = createPresageTracker({
  apiKey: () => (host ? host.getApiKey() : Promise.reject(new Error('preload bridge unavailable'))),
  ...(host ? { persist: (summary) => host.saveSession(summary) } : {}),
  onRawMetrics: (buf, tUs) => dump?.onRawMetrics(buf, tUs),
});
tracker.onValidation((v) => dump?.onValidation(v));
tracker.onStatus((s) => dump?.onStatus(s));
tracker.onStream((s) => dump?.onStream(s));

// Session capture: video + mic recording and per-frame samples, saved to
// sessions/<id>/ and uploaded to TigerData (see src/capture).
const captureHost = window.captureHost;
if (!captureHost) {
  showError({ code: 'NO_BRIDGE', name: 'PreloadMissing', message: 'window.captureHost is unavailable: sessions will not be recorded.', retryable: false });
}
const capture = captureHost ? new SessionCapture(captureHost, { audio: true }) : null;
tracker.onStream((s) => capture?.attachStream(s));
tracker.onSample((s) => capture?.addSample(s));
tracker.onValidation((v) => capture?.addValidation(v));
let lastCapturedId: string | null = null;

function showUpload(u: UploadState): void {
  const text: Record<UploadState['status'], string> = {
    pending: 'Uploading to TigerData…',
    uploaded: 'Uploaded to TigerData.',
    failed: `Upload failed: ${u.error ?? 'unknown error'}. The local copy is kept.`,
    'not-configured': 'Not uploaded: DATABASE_URL is not set. Saved locally only.',
  };
  ui.uploadStatus.textContent = text[u.status];
  ui.uploadStatus.dataset['status'] = u.status;
  ui.retryUpload.hidden = u.status !== 'failed';
  ui.retryUpload.disabled = false;
}

captureHost?.onUploadStatus((e) => {
  if (e.sessionId === lastCapturedId) showUpload(e.upload);
});
ui.retryUpload.addEventListener('click', () => {
  if (!captureHost || !lastCapturedId) return;
  ui.retryUpload.disabled = true;
  showUpload({ status: 'pending', attemptedAt: null, error: null });
  captureHost.retryUpload(lastCapturedId).then(showUpload, (err: unknown) =>
    showUpload({ status: 'failed', attemptedAt: null, error: err instanceof Error ? err.message : String(err) }),
  );
});

async function finishCapture(): Promise<void> {
  if (!capture) return;
  try {
    const result = await capture.finish();
    if (!result) return;
    const { session } = result;
    lastCapturedId = session.id;
    const secs = session.durationMs !== null ? `${(session.durationMs / 1000).toFixed(1)} s` : 'unknown length';
    ui.captureStatus.textContent =
      `Session ${session.id.slice(0, 8)}: ${secs} of video${session.video.hasAudio ? ' + mic' : ''}, ` +
      `${session.counts.face} face / ${session.counts.vitals} vitals rows. Saved in sessions/${session.id}/`;
    ui.captureBox.hidden = false;
    showUpload(session.upload);
    void runFlagPipeline(session.id);
  } catch (err) {
    showError({ code: 'CAPTURE_SAVE_FAILED', name: 'CaptureSaveFailed', message: err instanceof Error ? err.message : String(err), retryable: false });
  }
}

// ---------------------------------------------------------------------------
// Flags: "Flag this moment" while recording, the detector -> clip pipeline
// after Stop, and the review page (src/renderer/src/review.ts).

const flagsApi = window.flags;
if (!flagsApi) {
  showError({ code: 'NO_BRIDGE', name: 'PreloadMissing', message: 'window.flags is unavailable: flagging and review are off.', retryable: false });
}
const FLAG_LOOKBACK_MS = 5_000;

const review = setupReview(
  {
    session: $<HTMLSelectElement>('review-session'),
    detect: $<HTMLButtonElement>('review-detect'),
    clips: $<HTMLButtonElement>('review-clips'),
    status: $('review-status'),
    empty: $('review-empty'),
    cards: $('review-cards'),
  },
  flagsApi,
  captureHost,
);

function showView(view: 'record' | 'review', sessionId?: string): void {
  ui.recordView.hidden = view !== 'record';
  ui.reviewView.hidden = view !== 'review';
  ui.tabRecord.setAttribute('aria-pressed', String(view === 'record'));
  ui.tabReview.setAttribute('aria-pressed', String(view === 'review'));
  if (view === 'review') void review.open(sessionId);
  else for (const v of ui.reviewView.querySelectorAll('video')) v.pause();
}
ui.tabRecord.addEventListener('click', () => showView('record'));
ui.tabReview.addEventListener('click', () => showView('review'));
ui.reviewLast.addEventListener('click', () => {
  if (lastCapturedId) showView('review', lastCapturedId);
});

let flagNoteTimer: number | null = null;
function noteFlag(text: string): void {
  ui.flagNote.textContent = text;
  if (flagNoteTimer !== null) clearTimeout(flagNoteTimer);
  flagNoteTimer = window.setTimeout(() => (ui.flagNote.textContent = ''), 4_000);
}

function canFlag(): boolean {
  return !!flagsApi && !!capture?.sessionId && capture.videoTimeNowMs() !== null;
}

function updateFlagButton(): void {
  ui.flagMoment.disabled = !canFlag();
}

/** Flags the last 5 seconds of the recording as a manual flag. */
function flagMoment(): void {
  const id = capture?.sessionId;
  const now = capture?.videoTimeNowMs() ?? null;
  if (!flagsApi || !id || now === null) return;
  const endMs = Math.round(now);
  const startMs = Math.max(0, endMs - FLAG_LOOKBACK_MS);
  flagsApi.add(id, { type: 'manual', startMs, endMs }).then(
    (f) => noteFlag(`Flagged ${formatTime(f.startMs)} – ${formatTime(f.endMs)}`),
    (err: unknown) => showError({ code: 'FLAG_FAILED', name: 'FlagFailed', message: err instanceof Error ? err.message : String(err), retryable: true }),
  );
}
ui.flagMoment.addEventListener('click', flagMoment);
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'f' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (!canFlag()) return;
  e.preventDefault();
  flagMoment();
});

/** After Stop: run the detectors, then cut clips for every flag (detected or flagged while recording). */
async function runFlagPipeline(sessionId: string): Promise<void> {
  if (!flagsApi) return;
  ui.reviewLast.hidden = true;
  ui.flagsStatus.textContent = 'Looking for moments to review…';
  try {
    await flagsApi.runDetectors(sessionId);
    const { flags } = await flagsApi.list(sessionId);
    if (flags.length === 0) {
      ui.flagsStatus.textContent = 'No flagged moments in this session.';
      return;
    }
    ui.flagsStatus.textContent = `${flags.length} flagged moment(s). Cutting clips…`;
    ui.reviewLast.hidden = false;
    await flagsApi.generateClips(sessionId);
    const { clips } = await flagsApi.list(sessionId);
    const failed = clips.filter((c) => c.status === 'error').length;
    ui.flagsStatus.textContent = `${flags.length} flagged moment(s), ${clips.length} clip(s)${failed ? `, ${failed} failed` : ''}.`;
  } catch (err) {
    ui.flagsStatus.textContent = `Flags: ${err instanceof Error ? err.message : String(err)}`;
  }
}

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
  updateFlagButton();
}

tracker.onStatus((s) => {
  ui.status.textContent = STATUS_LABEL[s];
  ui.status.dataset['status'] = s;
  ui.start.disabled = tracker.sessionActive || s === 'starting' || s === 'stopping';
  // Stop stays available after an SDK error so the camera can be released and the partial session saved.
  ui.stop.disabled = !tracker.sessionActive || s === 'stopping';
  updateFlagButton();
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

function startSession(): void {
  resetPanel();
  ui.hint.dataset['kind'] = 'tuning';
  ui.hint.textContent = 'Starting camera…';
  sessionStartedAt = Date.now();
  renderTimer();
  timerHandle = window.setInterval(renderTimer, 500);
  if (host && debugConfig.dumpSeconds !== null) {
    dump = new PayloadDump(host, debugConfig.dumpSeconds, onDumpDone);
    dump.start();
  }
  capture?.begin();
  tracker.startSession().catch(() => {
    // Already surfaced through onError. Nothing was recorded, so the capture folder is discarded.
    void finishCapture();
    if (timerHandle !== null) clearInterval(timerHandle);
    ui.hint.dataset['kind'] = 'issue';
    ui.hint.textContent = 'Could not start. See the error above.';
  });
}

let stoppingSession = false;

async function stopSession(): Promise<void> {
  if (stoppingSession) return;
  stoppingSession = true;
  if (timerHandle !== null) clearInterval(timerHandle);
  await dump?.finish();
  // End the video when Stop was pressed, not after the SDK has drained.
  await capture?.stopRecording();
  try {
    const { summary, savedTo } = await tracker.stopSession();
    ui.hint.dataset['kind'] = 'idle';
    ui.hint.textContent = 'Session saved. Press Start session to go again.';
    const { series: _series, ...overview } = summary;
    ui.summaryJson.textContent = JSON.stringify(overview, null, 2);
    ui.summaryPath.textContent = savedTo ? `Saved to ${savedTo}` : 'Not saved (see errors).';
    ui.summaryBox.hidden = false;
    ui.summaryBox.open = true;
  } catch (err) {
    showError({ code: 'STOP_FAILED', name: 'StopFailed', message: err instanceof Error ? err.message : String(err), retryable: false });
  } finally {
    await finishCapture();
    stoppingSession = false;
  }
}

ui.start.addEventListener('click', startSession);
ui.stop.addEventListener('click', () => void stopSession());

// Unattended debug run: stop the session once the dump is written, then close.
function onDumpDone(): void {
  dump = null;
  if (!debugConfig.autorun) return;
  void (async () => {
    if (tracker.sessionActive) await stopSession();
    window.close();
  })();
}

// Window close: main waits for this, so the SDK is stopped (and the partial
// session saved) before the app exits.
host?.onShutdownRequest(async () => {
  await dump?.finish();
  await capture?.stopRecording();
  await tracker.shutdown();
  await finishCapture();
});
// Reloads (e.g. dev HMR) skip the close handshake; release synchronously.
// Samples and video already flushed stay on disk and are recovered on the next launch.
window.addEventListener('beforeunload', () => {
  capture?.dispose();
  tracker.dispose();
});

void host?.getDebugConfig().then((cfg) => {
  debugConfig = cfg;
  if (cfg.dumpSeconds === null) return;
  console.info(`[presage debug] payload dump on: ${cfg.dumpSeconds}s per session${cfg.autorun ? ', autorun' : ''}`);
  if (cfg.autorun) startSession();
});
