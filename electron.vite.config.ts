import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// The SmartSpectra SDK loads its native runtime from node_modules at runtime:
// resolve-native.js does require.resolve('@smartspectra/node-sdk-<plat>-<arch>/package.json')
// and koffi.load()s the DLL/dylib/so next to it. Bundling the SDK (or koffi)
// into out/main breaks that lookup, so both stay external in the main build.
// (src/presage/main.ts additionally require()s the SDK lazily, after it has set
// SMARTSPECTRA_CAPI_PATH for packaged builds.)
const SDK_EXTERNALS = ['@smartspectra/node-sdk', 'koffi'];
const sdkExternalPattern = /^(@smartspectra\/node-sdk|koffi)(\/.*)?$/;

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { include: SDK_EXTERNALS },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: [sdkExternalPattern],
      },
    },
  },
  preload: {
    build: {
      // The window runs with sandbox: true. A sandboxed preload can only
      // require('electron') and a few builtins, so it cannot load anything from
      // node_modules at runtime. The SDK's preload bridge
      // (@smartspectra/node-sdk/preload) is plain JS that only requires
      // 'electron' (no koffi, no native code), so it is bundled here.
      // scripts/verify-build.mjs asserts that no koffi/native code ends up in
      // the preload output.
      externalizeDeps: { exclude: ['@smartspectra/node-sdk'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: [/^koffi(\/.*)?$/],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
