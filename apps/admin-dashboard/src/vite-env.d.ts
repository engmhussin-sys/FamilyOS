/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  /**
   * There is deliberately NO `VITE_INTERNAL_ADMIN_API_KEY` here any more.
   * Everything named `VITE_*` is inlined into the JavaScript bundle at build
   * time, so shipping the platform admin secret that way publishes it to
   * anyone who opens the network tab. The operator enters the key at runtime
   * instead and it is held in memory only — the reasoning is written out in
   * `src/features/admin-key/adminKeyStore.ts`.
   */
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
