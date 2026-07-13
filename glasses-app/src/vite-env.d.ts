/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string
  readonly VITE_API_TOKEN?: string
  /** Build-time brand: 'genesis' (default) | 'kia' | 'hyundai'. See src/brand.ts. */
  readonly VITE_BRAND?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
