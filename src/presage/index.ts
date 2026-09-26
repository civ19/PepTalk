// Public renderer-side entry point of the Presage module.
//
//   import { createPresageTracker } from '../presage';
//
// Main process:  import { setupPresageMain } from '../presage/main'
// Preload:       import '../presage/preload'

export { createPresageTracker, type PresageTracker, type PresageTrackerOptions } from './tracker';
export { SessionRecorder, summarizeSession, type PersistFn, type RecordedSession } from './sessionRecorder';
export { MIN_VITALS_CONFIDENCE } from './constants';
export type { PresageHostBridge } from './bridge';
export * from './types';
