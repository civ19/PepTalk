// Preload half of session capture: exposes window.captureHost. Bundled into
// the (sandboxed) preload, so only 'electron' may be imported at runtime.

import { contextBridge, ipcRenderer } from 'electron';
import type { SampleRecord, Session, UploadState } from '../shared/session-types';
import { CAPTURE_IPC, type CaptureHostBridge, type UploadStatusEvent } from './bridge';

const captureHost: CaptureHostBridge = {
  begin: () => ipcRenderer.invoke(CAPTURE_IPC.begin) as Promise<{ id: string; dir: string }>,
  update: (id, patch) => ipcRenderer.invoke(CAPTURE_IPC.update, id, patch) as Promise<void>,
  appendVideo: (id, chunk) => ipcRenderer.invoke(CAPTURE_IPC.appendVideo, id, chunk) as Promise<void>,
  appendSamples: (id, records: SampleRecord[]) => ipcRenderer.invoke(CAPTURE_IPC.appendSamples, id, records) as Promise<void>,
  finish: (id, req) => ipcRenderer.invoke(CAPTURE_IPC.finish, id, req) as Promise<Session>,
  discard: (id) => ipcRenderer.invoke(CAPTURE_IPC.discard, id) as Promise<void>,
  retryUpload: (id) => ipcRenderer.invoke(CAPTURE_IPC.retryUpload, id) as Promise<UploadState>,
  onUploadStatus: (cb) => {
    ipcRenderer.on(CAPTURE_IPC.uploadStatus, (_e, payload: UploadStatusEvent) => cb(payload));
  },
};

contextBridge.exposeInMainWorld('captureHost', captureHost);
