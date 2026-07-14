/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only override of the proxy base URL (e.g. the local fake backend).
   * Never set when packing a distributable — production builds must use the
   * fixed, whitelisted proxy URL. */
  readonly VITE_BACKEND_URL?: string
  /** Build-time brand: 'genesis' (default) | 'kia' | 'hyundai'. See src/brand.ts. */
  readonly VITE_BRAND?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
