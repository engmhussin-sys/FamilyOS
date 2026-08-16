/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  /**
   * The internal admin key for `/admin/growth/*` (GROWTH_ANALYTICS_API §1).
   * Optional at the type level because a build without it still compiles and
   * still runs — every admin call simply fails 401 with the B3 envelope, and
   * the growth views render their error state instead of a blank screen.
   */
  readonly VITE_INTERNAL_ADMIN_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
