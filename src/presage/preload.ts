// Preload half of the Presage module. Import this from the app's preload script.
//
// 1. Installs the SmartSpectra preload bridge (window.__smartspectraBridge),
//    which the renderer SDK uses to stream frames to the main process.
// 2. Exposes window.presageHost for the API key and session saving.
//
// This file is bundled into the preload output (see electron.vite.config.ts):
// a sandboxed preload cannot require() from node_modules at runtime.

import '@smartspectra/node-sdk/preload';
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type PresageHostBridge } from './bridge';

let shutdownHandler: (() => Promise<void>) | null = null;
ipcRenderer.on(IPC.shutdownRequest, () => {
  void (async () => {
    try {
      await shutdownHandler?.();
    } catch (err) {
      console.error('[presage] shutdown handler failed', err);
    } finally {
      ipcRenderer.send(IPC.shutdownDone);
    }
  })();
});

const host: PresageHostBridge = {
  getApiKey: () => ipcRenderer.invoke(IPC.getApiKey) as Promise<string>,
  saveSession: (summary) => ipcRenderer.invoke(IPC.saveSession, summary) as Promise<string>,
  onShutdownRequest: (handler) => {
    shutdownHandler = handler;
  },
};

contextBridge.exposeInMainWorld('presageHost', host);
