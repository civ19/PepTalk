interface ImportMetaEnv {
  /** Base URL for backend API calls. Defaults to `/api` (proxied by Vite in dev). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
