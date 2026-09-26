# Presage vitals module

A self-contained [SmartSpectra](https://smartspectra.presagetech.com/docs/nodejs) (Presage) module for the interview/presentation practice app. While the user practices, it reads face and wellness signals from the webcam and records a timestamped session summary. Later, an LLM will combine that summary with the speech transcript.

It includes a small demo window: live preview, a face-landmark overlay, pulse, breathing, HRV, blink and talking indicators, eye contact (gaze direction), top expression, positioning hints, and errors.

> Wellness signals only. Nothing here is a health measurement, and the UI and JSON avoid medical vocabulary on purpose.

## Setup

Requirements: **Node.js 20+** (24 LTS recommended), Windows x64, macOS arm64 or Linux x64/arm64 (glibc 2.35+).

```bash
npm install
cp .env.example .env      # then paste your key into .env
```

`npm install` downloads the SmartSpectra native runtime for **every** platform (a few hundred MB). This is normal: only the package matching your machine is loaded. npm 11 prints an `allow-scripts` warning for `koffi` and `protobufjs`. You can ignore it, because koffi ships prebuilt binaries and loads fine without its install script.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PRESAGE_API_KEY` | yes | SmartSpectra API key from <https://physiology.presagetech.com/>. The main process reads it at runtime from the environment or from `.env` in the app directory. It is never bundled. The renderer requests it over IPC (the renderer SDK needs it). |
| `SMARTSPECTRA_DIAGNOSTICS` | no | `1` turns on the SDK's verbose IPC/frame-pump logging. |
| `SMARTSPECTRA_CAPI_PATH` | no | Overrides where the native library is loaded from. Packaged builds set this automatically to `resources/smartspectra/`. |
| `DATABASE_URL` | no | TigerData (Postgres + TimescaleDB) connection string. When set, finished sessions are uploaded; TLS is always on and verified. Without it, sessions stay local. |

`.env` is gitignored. So is `sessions/`, because recorded sessions are personal data.

## Run

| Command | What it does |
| --- | --- |
| `npm start` | Builds and launches the app (production build via `electron-vite preview`). |
| `npm run dev` | Dev server with hot reload. |
| `npm run verify` | Typecheck (strict, both tsconfigs), unit tests, build, then [post-build checks](scripts/verify-build.mjs): the SDK stays external in main, the preload is sandbox-safe, the native runtime resolves, no `any` outside the adapter, no blood-pressure/clinical wording. |
| `npm run package` | Unpacked packaged app in `release/` (electron-builder `--dir`). For a packaged app, set `PRESAGE_API_KEY` (and `DATABASE_URL`) in the environment, since `.env` is not shipped. |
| `npm run db:migrate` | Creates the TigerData tables ([db/migrations/](db/migrations/)). Run once per database. |
| `npm run export-fixture <id>` | Copies `sessions/<id>/` to `fixtures/<id>/` for developing analytics without a webcam. |
| `npm run inspect-frame <id> <tMs>...` | Alignment check: writes the video frame at each `tMs` with that moment's eye landmarks drawn on it. `-- --shift=150` draws deliberately misaligned landmarks for comparison. |
| `npm run debug:dump [-- <secs>]` | Starts a session by itself, writes the first 60 s of raw SDK events to `debug/payload-dump.ndjson`, stops, and closes. `-- --manual` dumps without auto-starting. |

Press **Start session** and sit centered, still and well lit. Press **Stop & save** to write `sessions/<iso-date>.json`. Packaged builds write to `%APPDATA%/presage-vitals-module/sessions/` (or the platform equivalent). Closing the window mid-session also stops the SDK and saves what was recorded.

`npm start` / `npm run dev` go through [scripts/launch.mjs](scripts/launch.mjs), which clears `ELECTRON_RUN_AS_NODE`. VS Code's integrated terminal exports it, and it makes Electron exit immediately.

## Why electron-vite

- It externalizes dependencies in the main process by default and lets you override that per package. The SDK must stay external: it finds its DLL/dylib through `require.resolve('@smartspectra/node-sdk-<plat>-<arch>/package.json')`. [electron.vite.config.ts](electron.vite.config.ts) also pins `@smartspectra/node-sdk` and `koffi` as external explicitly.
- One small config file with separate main/preload/renderer builds and Vite HMR for the renderer. No plugin stack.
- Forge's Vite template would work too, but it adds a second config layer (forge + three Vite configs) for no gain here. The SDK docs cover packaging for both, and this repo uses electron-builder, matching the official sample.

**One deliberate exception:** the SDK's *preload* bridge is **bundled** into `out/preload`, not external. The window runs with `sandbox: true`, and a sandboxed preload cannot `require()` anything from `node_modules` at runtime. `@smartspectra/node-sdk/preload` is plain JS that only requires `electron` (no koffi, no native code), so bundling it is safe. `npm run verify` asserts that no koffi or native loader ends up in the preload.

## Merging into the main app

All Presage-specific code lives in [src/presage/](src/presage/). The host app imports only these three entry points and never imports the SDK:

```ts
// main process
import { setupPresageMain } from './presage/main';
const presage = setupPresageMain({
  rendererFile,                                    // your index.html path
  devServerUrl: process.env.ELECTRON_RENDERER_URL,
  allowedMediaTypes: ['video', 'audio'],           // add 'audio' when you record speech
});
presage.attachWindow(win);   // SDK IPC, camera-permission scoping, graceful close

// preload
import './presage/preload';

// renderer
import { createPresageTracker } from './presage';
const tracker = createPresageTracker({
  apiKey: () => window.presageHost!.getApiKey(),
  persist: (summary) => window.presageHost!.saveSession(summary),
});
window.presageHost?.onShutdownRequest(async () => { await tracker.shutdown(); });

tracker.onSample((s) => { /* PresageSample: pulse, breathing, hrv, blinking, talking, expressions, landmarks, gaze */ });
tracker.onValidation((v) => { /* v.advice, e.g. "Move closer"; v.hint is the SDK's text */ });
tracker.onError((e) => { /* show it */ });
tracker.onWarning((w) => { /* metric group empty / recovered */ });
tracker.onStream((stream) => { video.srcObject = stream; });
await tracker.startSession();
const { summary, savedTo } = await tracker.stopSession();
```

When the main app starts recording audio for Gemini, pass `allowedMediaTypes: ['video', 'audio']`. The permission handler grants only the listed media types, and only to your own page (the `file://` index.html, or the dev-server origin in dev).

| File | Role |
| --- | --- |
| [src/presage/tracker.ts](src/presage/tracker.ts) | Public renderer API. Owns the SDK lifecycle, the event fan-out, and the empty-metric-group watchdog. |
| [src/presage/decode.ts](src/presage/decode.ts) | The only adapter from the SDK's protobuf payload to our types. Everything is narrowed from `unknown`. |
| [src/presage/sessionRecorder.ts](src/presage/sessionRecorder.ts) | Framework-agnostic recorder and pure `summarizeSession()`. No DOM, SDK or Electron imports. |
| [src/presage/types.ts](src/presage/types.ts) | All public types, including the summary schema. |
| [src/presage/constants.ts](src/presage/constants.ts) | Confidence thresholds, windows, watchdog timing. |
| [src/presage/metrics.ts](src/presage/metrics.ts) | Requested metric codes. |
| [src/presage/main.ts](src/presage/main.ts), [preload.ts](src/presage/preload.ts), [bridge.ts](src/presage/bridge.ts) | Electron wiring and the IPC contract. |

### Metrics requested

`faceMetrics + cardioMetrics + breathingMetrics`, **minus `ARTERIAL_PRESSURE_TRACE`**. The cardio bundle includes a pressure waveform, which conflicts with the wellness-only rule, so it is not requested at all. Pulse rate and HRV are separate metric codes and arrive without it (verified live). The breathing bundle's pause-detection field is requested as part of the bundle but never read.

Unauthorized metrics come back **empty, with no error**. The watchdog warns (in the UI and the console) when a requested group has produced nothing ~15 s after the SDK reports Running (cardio gets 25 s, see limitations). The warning says which cause is more likely:
- If the face has been valid for at least 5 s, the likely cause is an **authorization gap**.
- Otherwise it's **signal/positioning**, and the warning is repeated if the face later becomes valid.

It also posts a "recovered" note if data shows up later.

## Session summary JSON

`sessions/<iso-date>.json`, with `:` replaced by `-` for Windows (e.g. `2026-09-26T15-29-20.651Z.json`). The authoritative schema is `SessionSummary` in [src/presage/types.ts](src/presage/types.ts).

**Clock.** `tUs` is the SmartSpectra timestamp in µs. In Electron the renderer SDK anchors camera frame times to the Unix epoch once, then keeps them strictly monotonic. `tMs` is milliseconds since `startedAtEpochMs`, i.e. `tMs = tUs / 1000 - startedAtEpochMs`. To align a transcript, express its word/segment offsets relative to `startedAtEpochMs` (start audio capture at the same moment as `startSession()`, or record the offset).

```jsonc
{
  "schemaVersion": 1,
  "startedAt": "2026-09-26T15:29:20.651Z", "endedAt": "…", "startedAtEpochMs": 1790436560651, "durationMs": 77132,
  "clock": { "description": "…", "firstSdkTimestampUs": 1790436562691000, "lastSdkTimestampUs": 1790436637570901 },

  "pulse": {                       // readings with confidence >= 40 only
    "avg": 86.2, "min": 81.9, "max": 88.5, "unit": "bpm",
    "samplesUsed": 15, "samplesDroppedLowConfidence": 7, "minConfidence": 40,
    "timeline": [{ "startMs": 0, "endMs": 10000, "avg": null, "samples": 0 }, …]   // per 10 s
  },
  "breathing": {                   // confidence >= 45 AND not from a talking-heavy 30 s window
    "avg": 14.1, "min": 12.0, "max": 16.3, "unit": "breaths/min",
    "samplesUsed": 3, "samplesDroppedLowConfidence": 11, "samplesExcludedWhileTalking": 2, "minConfidence": 45,
    "note": "Breathing rate is a 30 s rolling average and is unreliable while talking …"
  },
  "hrv": {                         // latest reading that is stable and confidence >= 50
    "latestStable": { "tMs": 65000, "rmssdMs": 42, "sdnnMs": 50, "meanNnMs": 820, "baevsky": 90, "confidence": 70 } /* or null */,
    "samplesUsed": 2, "samplesDroppedLowConfidence": 1, "minConfidence": 50, "note": "HRV uses a 60 s window …"
  },
  "blinks":   { "count": 13, "perMinute": 10.8, "onsetsMs": [12232, 14201, …] },
  "gaze":     { "eyeContactRatio": 0.82, "lookAways": [{ "startMs": 41200, "endMs": 44900, "direction": "down" }, …], "awayDirections": { "down": 0.7, "left": 0.3 }, … },
  "talking":  { "ratio": 0.42, "talkingMs": 30300, "observedMs": 72083, "intervals": [{ "startMs": 8041, "endMs": 11193 }, …] },
  "expressions": {
    "distribution": { "neutral": 0.705, "surprise": 0.199, "happy": 0.037, … },   // share of readings where each was top
    "timeline": [{ "startMs": 0, "endMs": 10000, "dominant": "neutral", "distribution": { … }, "samples": 210 }, …],
    "samples": 1698
  },
  "face": { "validRatio": 0.753, "validMs": 56566, "observedMs": 75092 },          // camera-tuning time excluded
  "validationIssues": [
    { "code": 12, "name": "ExcessiveMotion", "hint": "Hold still - motion may affect accuracy.", "startMs": 15544, "endMs": 16552 }, …
  ],
  "emptyMetricGroups": [],         // requested groups that produced nothing all session
  "series": {                      // accepted readings, for transcript alignment
    "pulse":     [{ "tMs": 12000, "tUs": …, "bpm": 88, "confidence": 61.2 }, …],
    "breathing": [{ "tMs": 33544, "tUs": …, "breathsPerMin": 6, "confidence": 50.1, "excludedWhileTalking": true }, …],
    "hrv":       [{ "tMs": …, "tUs": …, "rmssdMs": …, "sdnnMs": …, "baevsky": …, "confidence": … }]
  }
}
```

The numbers above come from a real 77 s test session, except `breathing` and `hrv`: those are illustrative, because that session produced no breathing or HRV readings that qualified.

Tunables are in [src/presage/constants.ts](src/presage/constants.ts): `MIN_VITALS_CONFIDENCE` (defaults are the SDK's own "stable" cut-offs from the data-types docs), `BREATHING_MAX_TALKING_FRACTION` (0.1), `TIMELINE_BUCKET_MS` (10 s), and the watchdog timings.

## Session recording and storage (for analytics)

Every session is also recorded as **video + mic** and **per-frame samples**, all on one clock, so an analytics module can find a moment and play it. The contract is [src/shared/session-types.ts](src/shared/session-types.ts): import its types, don't parse by hand.

```
sessions/<uuid>/
  session.json      Session: start time, duration, clock anchor, video info, upload status
  samples.ndjson    one SampleRecord per line: face (~30/s), vitals, validation changes
  recording.mp4     H.264 + Opus (or .webm), remuxed with ffmpeg so it is seekable
```

**The clock.** Every `tMs` is milliseconds since the first frame of `recording.*`. Seek the video to `tMs / 1000` and the face sample with that `tMs` describes that frame. In a test recording, the video's frame timestamps and the stored face-sample `tMs` values lined up frame for frame, within 0.6 ms. Rows are written in arrival order, so sort by `tMs`. Vitals arrive 1-10 s after the moment they describe, and their `tMs` is the moment described.

How that's achieved (from `npm run debug:dump`, see [src/capture/clockMatch.ts](src/capture/clockMatch.ts)):
- SmartSpectra stamps each frame with Chromium's raw capture timestamp (`VideoFrame.timestamp`) plus a constant it sets from `Date.now()` when its frame loop reads its first frame. That read happens after the SDK's start handshake, so the SDK's "epoch" timestamps ran **65 ms and 786 ms ahead** of real capture time in two runs. They are not trusted directly.
- Instead, a probe on a clone of the camera track sees the same raw timestamps. SDK timestamps are matched to them frame by frame (exact to ±200 µs), and `tMs` is computed relative to the raw timestamp of the first recorded frame. If matching fails, the session falls back to wall-clock anchoring and says so in `session.json` (`clock.method: 'wall-clock'`).
- The first Presage reading normally lands at `tMs` ≈ 0.3-1.5 s: the camera, and so the video, starts before the SDK finishes starting up. Each stop logs this as a clock check.

**What's in a sample** (all fields nullable, because the SDK doesn't report every field every frame):
- `face`: `blinking`, `talking`, `expressions` (8 probabilities summing to 1), `eyeLandmarks` (corners, lids, iris center + contour per eye; MediaPipe indices in `FACE_MESH`, pixel coordinates of the unmirrored frame), `headPose` (unitless yaw/pitch estimates; compare against the session's own median), `gaze` (the eye-contact estimate from [gaze.ts](src/presage/gaze.ts)).
- `vitals`: pulse, HRV (RMSSD, SDNN, mean NN, Baevsky) and breathing, each with the SDK's 0-100 confidence and `stable` flag. Usually one group per row.
- `validation`: positioning/signal status (`Ok`, `FaceNotForward`, `ChestNotVisible`, …). The SDK repeats it every frame; only changes are stored.

**Crash safety.** Video chunks are appended every second and samples every 500 ms, as they arrive. If the app dies mid-session, the next launch remuxes what was saved, marks the session `interrupted`, and uploads it.

**TigerData.** With `DATABASE_URL` set and `npm run db:migrate` run once, each stopped session is uploaded in the background: `sessions`, plus `vitals_samples` and `face_samples` (hypertables) and `validation_events`, keyed by `(session_id, t)` with `t = sessions.started_at + t_ms`. It is one transaction per session, and `sessions.uploaded` becomes true only together with the rows. Videos stay local (`recording_uri` is a `file://` path). On failure the local copy is kept. The app shows **Retry upload**, and any session not yet uploaded is retried at the next launch.

**Fixtures.** `npm run export-fixture <id>` copies a session to `fixtures/<id>/` (gitignored: it contains a real face, voice and vitals, so share it only with that person's consent).

## Flags, clips and review

Moments worth reviewing become **flags**. Each flag gets a short **clip** cut from the recording, and the **Review** tab shows them. The contract is [src/shared/flags.ts](src/shared/flags.ts).

```
sessions/<uuid>/
  flags.json          FlagsFile: detector and manual flags (the source of truth)
  clips.json          ClipsFile: planned clips and their status
  clips/<id>.mp4      H.264 + AAC, moov first; clip time 0 = session time clip.startMs
  clips/<id>.jpg      thumbnail: the frame at the flagged moment's midpoint
  flags-sync.json     hash of what was last mirrored to TigerData
```

- **Where flags come from.** Detectors ([src/main/flags/detectors.ts](src/main/flags/detectors.ts)) run on a stopped session. There is one so far, `high_hr`, and it is a **placeholder** that exists so the pipeline can run on real data: pulse above baseline (median of the first 30 s) + 15 bpm for 5 s or more. To add a detector, append it to `DETECTORS`. Manual flags come from **Flag this moment** (hotkey **F**, flags the last 5 s) while recording, or from `npm run flag`. After **Stop & save**, the detectors run and clips are cut automatically.
- **Clips** ([src/main/clips/](src/main/clips/)): 3 s of padding before each flag and 2 s after, clamped to the video. Flags whose padded windows overlap share one clip. Clips are at least 4 s and at most 20 s; a longer chain of flags is split. Clip ids depend only on (session, start, end), so existing files are reused, and after changing encoder settings you delete `clips/` to re-cut. Clips are cut two at a time in the main process, with progress on `window.flags.onClipUpdate`. Frame timing matches the recording (it's variable frame rate).
- **Renderer access** is through `window.flags` ([src/shared/flags-bridge.ts](src/shared/flags-bridge.ts)). Media comes from the `clip://local/<sessionId>/<path>` protocol ([src/main/clips/protocol.ts](src/main/clips/protocol.ts)). It serves only media files inside the sessions folder and supports range requests, so `<video>` can seek.
- **TigerData:** `npm run db:migrate` adds the `flags` and `clips` tables ([db/migrations/002_flags_clips.sql](db/migrations/002_flags_clips.sql)). They mirror the JSON files: metadata, evidence as jsonb, and the clip's `file://` URI, never video data. A session's flags are mirrored right after the session uploads, again after every change, and at the next launch if a sync failed.

| Command | What it does |
| --- | --- |
| `npm run flag -- <id> <startMs> <endMs> <type>` | Adds a manual flag (`type`: `high_hr`, `low_eye_contact`, `fast_pace`, `slow_pace`, `tense_expression`, `manual`). |
| `npm run clips -- <id>` | Cuts clips for the session's flags. |
| `npm run detect -- <id>` | Runs the detectors (replaces detector flags, keeps manual ones). |
| `npm run flags:check -- <id>` | Read-only: checks that flags.json, clips.json, the clip files and the TigerData rows agree. |

These CLI commands run the app's own code through vite-node, on `./sessions` or the packaged app's sessions folder. Don't run them on a session the app is cutting clips for at the same moment.

## Known limitations

- **Lighting.** Dim or backlit faces produce `TooDark` / `TooBright` hints and low confidence. In one early test in a dim room, the SDK hit `ProcessingFailed (8)` about 13 s after Running and stopped producing data. I couldn't reproduce it in good light. The app shows the error and keeps **Stop & save** available so the camera can be released and the partial session kept. It does not auto-recover (`reset()`).
- **Motion, a second face, and framing** (`ExcessiveMotion`, `MultipleFacesFound`, `ChestNotVisible`) pause good readings. They are recorded as `validationIssues` intervals.
- **Breathing uses a 30 s window**, and confidence is 0 until it fills. Presage says breathing "does not work when talking", so readings whose 30 s window was more than 10 % talking are excluded. In an answer-heavy session, expect few or no usable breathing readings. That is by design.
- **HRV uses a 60 s window**, and confidence is 0 until it fills. Sessions under ~60 s of clean signal have no HRV. In a 77 s test with motion and a second face in frame, the SDK emitted no HRV readings at all, so **HRV output is untested end to end**.
- **Pulse is a 12 s average.** In testing, the first cardio reading arrived about 16 s after Running, so the cardio watchdog waits 25 s instead of 15 s. Early pulse readings are often low-confidence and are dropped from the summary.
- **Landmarks** are pixel coordinates in the 1280×720 processed frame and are drawn over the mirrored preview. The SDK logs `Using NORM_RECT without IMAGE_DIMENSIONS is only supported for the square ROI` on every run, which may mean slight distortion of landmark positions on 16:9 frames. They looked roughly aligned in testing.
- **Readings are sparse and bursty.** Pulse arrived as ~22 readings in 77 s, some in bursts, so the 10 s timeline has empty buckets.
- **Landmarks are whole pixels.** An eye is ~40-55 px wide at 720p, so iris position (and gaze) moves in steps of ~2% of eye width. Occlusion (a hand or pen near the face) visibly pulls landmarks off; that's the model, not the clock.
- **Occasional native crash on exit.** Sometimes (1 of 4 test runs) closing the app ends in `FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw` during SDK teardown, after everything was saved. Session data is on disk before this point, and any interrupted upload is retried at the next launch.
- **Only Windows x64 was run.** macOS/Linux follow the documented paths but are unverified.
- **The API key reaches the renderer**, because the renderer SDK takes it in its constructor. It is fetched at runtime over IPC (only from our own page), never bundled.
