import type { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

export type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

export interface AppSettings {
  backendUrl: string
  token: string
  climateTemp: number
  climateDefrost: boolean
  // Steering wheel + rear window/mirror heat with climate
  climateHeating: boolean
  // AC/DC charge targets (percent, 50–100) sent via "Send limits to car"
  chargeLimitAc: number
  chargeLimitDc: number
}

// Dev-only convenience: `VITE_BACKEND_URL`/`VITE_API_TOKEN` seed the defaults
// so the simulator can run against a local backend without the phone UI.
// Don't set them when packing a distributable .ehpk.
export const DEFAULT_SETTINGS: AppSettings = {
  backendUrl: import.meta.env.VITE_BACKEND_URL ?? '',
  token: import.meta.env.VITE_API_TOKEN ?? '',
  climateTemp: 21,
  climateDefrost: false,
  climateHeating: false,
  chargeLimitAc: 80,
  chargeLimitDc: 90,
}

// Browser localStorage/IndexedDB do NOT reliably persist in the Even App
// WebView — bridge storage is the only durable store.
//
// Renaming this key orphans every install's saved settings (the app boots as
// if unconfigured). Not brand-scoped: each brand packs as its own app with its
// own package_id, so their storage is already separate.
const KEY = 'connect-remote.settings'

export async function loadSettings(bridge: Bridge): Promise<AppSettings> {
  try {
    const raw = await bridge.getLocalStorage(KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch (err) {
    console.warn('failed to load settings, using defaults', err)
  }
  return { ...DEFAULT_SETTINGS }
}

export async function saveSettings(bridge: Bridge, settings: AppSettings): Promise<boolean> {
  return bridge.setLocalStorage(KEY, JSON.stringify(settings))
}

export function isConfigured(settings: AppSettings): boolean {
  return settings.backendUrl.trim() !== '' && settings.token.trim() !== ''
}
