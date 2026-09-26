// Contract between the renderer-side tracker and the Electron main process.
// Shared by src/presage/main.ts, src/presage/preload.ts and the renderer.

import type { SessionSummary } from './types';

export const IPC = {
  getApiKey: 'presage:get-api-key',
  saveSession: 'presage:save-session',
  /** main -> renderer: the window wants to close; stop the SDK first. */
  shutdownRequest: 'presage:shutdown-request',
  /** renderer -> main: SDK stopped and destroyed; the window may close. */
  shutdownDone: 'presage:shutdown-done',
  /** Debug payload dump (PRESAGE_DEBUG_DUMP_SECONDS): config + NDJSON appends to debug/payload-dump.ndjson. */
  getDebugConfig: 'presage:get-debug-config',
  debugAppend: 'presage:debug-append',
} as const;

/** Set from the environment in the main process; null fields mean "off". */
export interface DebugConfig {
  /** Seconds of raw payloads to dump per session, or null when the dump is off. */
  dumpSeconds: number | null;
  /** Start a session on load, stop it after dumpSeconds and close the window (for unattended runs). */
  autorun: boolean;
}

/** What src/presage/preload.ts exposes on `window.presageHost`. */
export interface PresageHostBridge {
  /** Reads PRESAGE_API_KEY from the main process (never bundled into the renderer). */
  getApiKey(): Promise<string>;
  /** Writes the summary to sessions/<iso-date>.json; resolves to the absolute path. */
  saveSession(summary: SessionSummary): Promise<string>;
  /**
   * Registers the handler main calls before closing the window. Main waits for
   * it to settle (with a timeout) so the SDK is stopped before the app exits.
   */
  onShutdownRequest(handler: () => Promise<void>): void;
  getDebugConfig(): Promise<DebugConfig>;
  /** Appends NDJSON lines to debug/payload-dump.ndjson; `truncate` starts a fresh file. */
  debugAppend(lines: string[], truncate: boolean): Promise<string>;
}

declare global {
  interface Window {
    presageHost?: PresageHostBridge;
  }
}
