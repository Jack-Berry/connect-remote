/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only override of the proxy base URL (e.g. the local fake backend).
   * Never set when packing a distributable — production builds must use the
   * fixed, whitelisted proxy URL. */
  readonly VITE_BACKEND_URL?: string
  /** Build-time brand: 'genesis' (default) | 'kia' | 'hyundai'. See src/brand.ts. */
  readonly VITE_BRAND?: string
  /** Dev-only: seed fake credentials so the simulator reaches the HUD
   * against a mock proxy. Ignored outside `vite dev` (DEV guard). */
  readonly VITE_FAKE_CREDS?: string
  /** Dev-only: drive the car finder from a scripted fake phone position
   * instead of real GPS, so every finder state is reachable in the simulator.
   * 'walk' | 'denied' | 'unavailable'. Ignored outside `vite dev` (DEV guard);
   * see src/geo.ts. */
  readonly VITE_FAKE_GPS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
