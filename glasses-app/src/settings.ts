import type { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

export type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

export interface AppSettings {
  // Connected Services account. Sent per-request to the hosted proxy over
  // HTTPS; stored only in Even app bridge storage on the phone (see below).
  username: string
  password: string
  pin: string
  // hyundai_kia_connect_api region code: 1=EU 2=CA 3=US 5=AU. The numeric
  // brand code is build-time (src/brand.ts), not a setting.
  region: number
  climateTemp: number
  climateDefrost: boolean
  // Steering wheel + rear window/mirror heat with climate
  climateHeating: boolean
  // AC/DC charge targets (percent, 50–100) sent via "Send limits to car"
  chargeLimitAc: number
  chargeLimitDc: number
}

export const REGIONS: { code: number; label: string }[] = [
  { code: 1, label: 'Europe' },
  { code: 2, label: 'Canada' },
  { code: 3, label: 'USA' },
  { code: 5, label: 'Australia' },
]

export const DEFAULT_SETTINGS: AppSettings = {
  username: '',
  password: '',
  pin: '',
  region: 1,
  climateTemp: 21,
  climateDefrost: false,
  climateHeating: false,
  chargeLimitAc: 80,
  chargeLimitDc: 90,
}

// Browser localStorage/IndexedDB do NOT reliably persist in the Even App
// WebView — bridge storage is the only durable store. The credentials live
// here and nowhere else: the proxy is stateless and never stores them.
//
// Renaming this key orphans every install's saved settings (the app boots as
// if unconfigured). Not brand-scoped: each brand packs as its own app with its
// own package_id, so their storage is already separate.
const KEY = 'connect-remote.settings'

export async function loadSettings(bridge: Bridge): Promise<AppSettings> {
  try {
    const raw = await bridge.getLocalStorage(KEY)
    // Pre-1.1 installs stored backendUrl/token here; those keys are simply
    // ignored and disappear on the first save of the new shape.
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch (err) {
    console.warn('failed to load settings, using defaults', err)
  }
  return { ...DEFAULT_SETTINGS }
}

export async function saveSettings(bridge: Bridge, settings: AppSettings): Promise<boolean> {
  return bridge.setLocalStorage(KEY, JSON.stringify(settings))
}

// PIN deliberately not required: which accounts need one varies by brand and
// region, and the proxy reports a clear 401 when it was needed and missing.
export function isConfigured(settings: AppSettings): boolean {
  return settings.username.trim() !== '' && settings.password.trim() !== ''
}
