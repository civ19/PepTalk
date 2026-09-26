// Preload half of flags and clips: exposes window.flags (see FlagsBridge).
// Bundled into the sandboxed preload, so only 'electron' may be imported at runtime.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Clip, Flag } from '../shared/flags';
import { FLAGS_IPC, sessionFileUrl, type FlagsBridge } from '../shared/flags-bridge';

const flags: FlagsBridge = {
  list: (sessionId) => ipcRenderer.invoke(FLAGS_IPC.list, sessionId) as Promise<{ flags: Flag[]; clips: Clip[] }>,
  add: (sessionId, flag) => ipcRenderer.invoke(FLAGS_IPC.add, sessionId, flag) as Promise<Flag>,
  runDetectors: (sessionId) => ipcRenderer.invoke(FLAGS_IPC.runDetectors, sessionId) as Promise<Flag[]>,
  generateClips: (sessionId) => ipcRenderer.invoke(FLAGS_IPC.generateClips, sessionId) as Promise<void>,
  onClipUpdate: (cb) => {
    const listener = (_event: IpcRendererEvent, clip: Clip): void => cb(clip);
    ipcRenderer.on(FLAGS_IPC.clipUpdate, listener);
    return () => {
      ipcRenderer.removeListener(FLAGS_IPC.clipUpdate, listener);
    };
  },
  clipUrl: (clip) => sessionFileUrl(clip.sessionId, clip.path),
  thumbUrl: (clip) => sessionFileUrl(clip.sessionId, clip.thumbPath),
};

contextBridge.exposeInMainWorld('flags', flags);
