/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * "1" in the static GitHub Pages build (`npm run build:pages`), undefined
   * otherwise. When set, the client never calls /api/* and uses the in-browser
   * demo backend instead (see demo-backend.ts / api.ts).
   */
  readonly VITE_STATIC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
