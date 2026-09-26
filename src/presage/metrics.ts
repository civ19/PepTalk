// Which SmartSpectra metrics we request.
//
// Face + cardio + breathing bundles, minus ARTERIAL_PRESSURE_TRACE: this is a
// wellness-only app and never shows a pressure waveform, so there is no reason
// to compute it. (It is also the one cardio metric that needs the SDK's
// encrypted device-key model.) Pulse rate and HRV are separate metric codes
// and arrive without it; this was checked against the live SDK.

import { breathingMetrics, cardioMetrics, faceMetrics } from '@smartspectra/node-sdk/renderer';

// MetricType wire value from https://smartspectra.presagetech.com/docs/data-types
// (stable: "Use the listed names — do not renumber"). The SDK exports the
// bundles but not the MetricType enum itself.
const ARTERIAL_PRESSURE_TRACE = 16;

const EXCLUDED: ReadonlySet<number> = new Set([ARTERIAL_PRESSURE_TRACE]);

export const REQUESTED_METRICS: readonly number[] = [...faceMetrics, ...cardioMetrics, ...breathingMetrics].filter(
  (m) => !EXCLUDED.has(m),
);
