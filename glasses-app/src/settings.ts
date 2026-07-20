import type { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

export type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

export type TempUnit = 'C' | 'F'

export interface AppSettings {
  // Connected Services account. Sent per-request to the hosted proxy over
  // HTTPS; stored only in Even app bridge storage on the phone (see below).
  username: string
  password: string
  pin: string
  // hyundai_kia_connect_api region code: 1=EU 2=CA 3=US 5=AU. The numeric
  // brand code is build-time (src/brand.ts), not a setting.
  region: number
  // ALWAYS Celsius — the canonical unit for storage and for the /climate wire
  // format, regardless of what the user sees. `tempUnit` is a display/entry
  // preference only; converting on the wire is the proxy's job (it alone knows
  // what unit the region's upstream API wants). See resolveTempUnit.
  climateTemp: number
  // Display unit for every temperature the user sees. Undefined means "never
  // explicitly chosen" and is resolved from the region (US→F, else C) — so a
  // US user gets Fahrenheit without touching the toggle, and picking the
  // toggle once pins it forever after. See resolveTempUnit.
  tempUnit?: TempUnit
  climateDefrost: boolean
  // Steering wheel + rear window/mirror heat with climate
  climateHeating: boolean
  // AC/DC charge targets (percent, 50–100) sent via "Send limits to car"
  chargeLimitAc: number
  chargeLimitDc: number
  // Kia-US only: stored device token from OTP enrollment. Contains
  // device_id + refresh_token (no credentials — they're stripped by the
  // proxy). Sent per-request so the proxy can reuse a trusted device
  // identity without storing anything server-side.
  kiaUsDeviceToken?: Record<string, unknown>
  // Last backend powertrain classification seen (raw server string — may be
  // a label this build doesn't know), and whether that status carried
  // fuel-only evidence (fuel level present, no EV battery). Persisted so the
  // phone form shows the right sections on next open without a fetch.
  lastPowertrain?: string
  lastPowertrainFuelOnly?: boolean
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

// ---------------------------------------------------------------------------
// Temperature units
//
// `climateTemp` is stored and sent in Celsius, always. These helpers convert
// only for what the user reads and types. The proxy converts to whatever the
// upstream API wants (US regions genuinely want Fahrenheit on the wire) — the
// phone must never send anything but Celsius.
// ---------------------------------------------------------------------------

// Canonical Celsius bounds, matching the proxy's own validation
// (ClimateBody.temp: ge=14, le=30). Entry in either unit clamps to these.
export const CLIMATE_MIN_C = 14
export const CLIMATE_MAX_C = 30

export function cToF(c: number): number {
  return c * 9 / 5 + 32
}

export function fToC(f: number): number {
  return (f - 32) * 5 / 9
}

// Which unit to show. An explicit choice always wins; otherwise infer from the
// account region, since region 3 (USA) is the only one whose users expect F.
// Region defaults to 1 (Europe) on a fresh install, so an untouched app shows
// Celsius until the user actually selects USA.
export function resolveTempUnit(s: AppSettings): TempUnit {
  return s.tempUnit ?? (s.region === 3 ? 'F' : 'C')
}

// Celsius is entered in 0.5 steps, Fahrenheit in whole degrees — half a degree
// F is below what any of these cars resolve, and whole-F values survive the
// round trip through 0.5°C storage (a 1°F step is 0.56°C, comfortably wider
// than the 0.25°C worst-case snapping error).
export function tempStep(unit: TempUnit): number {
  return unit === 'F' ? 1 : 0.5
}

// Input bounds in the display unit, kept strictly inside the Celsius bounds so
// a value typed at either extreme never clamps to something else on save:
// 14°C is 57.2°F, so F starts at 58 (ceil), not 57.
export function tempBounds(unit: TempUnit): { min: number; max: number } {
  if (unit === 'C') return { min: CLIMATE_MIN_C, max: CLIMATE_MAX_C }
  return { min: Math.ceil(cToF(CLIMATE_MIN_C)), max: Math.floor(cToF(CLIMATE_MAX_C)) }
}

// Display-unit value → canonical Celsius, clamped and snapped to a 0.5°C grid.
// NaN (empty/garbage field) falls back to the default rather than poisoning
// the saved settings.
export function toCanonicalC(value: number, unit: TempUnit): number {
  if (isNaN(value)) return DEFAULT_SETTINGS.climateTemp
  const c = unit === 'F' ? fToC(value) : value
  const clamped = Math.min(CLIMATE_MAX_C, Math.max(CLIMATE_MIN_C, c))
  return Math.round(clamped * 2) / 2
}

// Canonical Celsius → the number to put in the input for the display unit.
//
// Clamped to the display unit's own bounds, because rounding can land just
// outside them: 14°C is 57.2°F, which rounds to 57 while the F field starts at
// 58. Showing an out-of-range number lets the browser clamp it for us on the
// next edit, which is how a value silently changes behind the user's back.
// The half-degree that costs at the very bottom of the range is the price of
// keeping the F bounds strictly inside the Celsius ones.
export function fromCanonicalC(celsius: number, unit: TempUnit): number {
  if (unit === 'C') return celsius
  const { min, max } = tempBounds('F')
  return Math.min(max, Math.max(min, Math.round(cToF(celsius))))
}

// Canonical Celsius → a label, e.g. "21°C" or "70°F". Used on the glasses.
export function formatTemp(celsius: number, unit: TempUnit): string {
  return `${fromCanonicalC(celsius, unit)}°${unit}`
}

// Everything the phone's temperature field looks like in a given unit. Kept
// here, and as one object, so the value can't drift out of step with the
// bounds that constrain it — setting a Fahrenheit value against leftover
// Celsius min/max is exactly how a "70" silently clamps to 30.
export interface TempFieldState {
  value: string
  min: string
  max: string
  step: string
  label: string
}

export function tempFieldState(celsius: number, unit: TempUnit): TempFieldState {
  const { min, max } = tempBounds(unit)
  return {
    value: String(fromCanonicalC(celsius, unit)),
    min: String(min),
    max: String(max),
    step: String(tempStep(unit)),
    label: `Climate target temperature (°${unit})`,
  }
}

// Phone form: does the charge-limits section (AC/DC prefs + "Send limits to
// car") apply to this car? Only cars that plug in. Positive HEV/ICE hide it;
// UNKNOWN or a label this build doesn't recognise stays permissive UNLESS the
// status carried fuel-only evidence: the proxy emits fuel fields only on
// genuine fuel evidence, never for an EV (POWERTRAIN-FIELDS landmines 1–2),
// so fuel-without-EV-battery means a car that cannot plug in. No
// classification at all (older proxy, or nothing fetched yet) → show
// everything, matching pre-powertrain behaviour.
export function chargeLimitsRelevant(
  powertrain: string | null | undefined,
  fuelOnly: boolean | undefined,
): boolean {
  if (powertrain === 'EV' || powertrain === 'PHEV') return true
  if (powertrain === 'HEV' || powertrain === 'ICE') return false
  if (powertrain != null) return !fuelOnly
  return true
}
