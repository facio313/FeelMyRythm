/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __FMR_PWA_ENABLED__: boolean;

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
