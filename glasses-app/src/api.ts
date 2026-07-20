/** Backend powertrain classification. UNKNOWN = conflicting or insufficient
 *  signals; the UI must render only what is genuinely present. Typed as
 *  string because the value is server-driven — an unrecognized label must
 *  degrade like UNKNOWN, never crash. */
export type Powertrain = "EV" | "PHEV" | "HEV" | "ICE" | "UNKNOWN";

/** Every field is optional AND nullable: no powertrain populates all of
 *  them, and an older proxy omits the newer ones entirely. Render paths must
 *  null-guard every access — an absent field draws nothing, never "0%",
 *  "undefined" or a crash. */
export interface VehicleStatus {
  powertrain?: Powertrain | string | null
  // EV side — absent on HEV/ICE.
  soc_percent?: number | null
  range_value?: number | null
  // Covers all ranges in the response (range_value, fuel_range, total_range).
  range_unit?: string | null
  locked?: boolean | null
  charging?: boolean | null
  charge_eta_minutes?: number | null
  climate_on?: boolean | null
  doors_open?: string[] | null
  // Car position — consumed by the "Find my car" finder mode.
  latitude?: number | null
  longitude?: number | null
  /** When the car last reported that position — drives "parked 2h ago".
   *  Absent from an older proxy, in which case the finder omits the age
   *  line rather than guessing from last_updated (a car parked hours ago
   *  still refreshes its status). */
  location_last_updated?: string | null
  last_updated?: string | null
  charge_limit_ac?: number | null
  charge_limit_dc?: number | null
  // Fuel side — only sent for fuel-bearing powertrains (PHEV/HEV/ICE, or
  // UNKNOWN with real fuel evidence). Never sent for an EV.
  fuel_level_percent?: number | null
  fuel_range?: number | null
  total_range?: number | null
  stale?: boolean | null
}

/** Sent in every request body. The proxy is stateless: it holds no account
 * config, so username/password/PIN/region/brand ride along each time. */
export interface Credentials {
  username: string
  password: string
  pin: string
  region: number
  brand: number
  /** Kia-US only: stored device token from OTP enrollment. */
  device_token?: Record<string, unknown>
}

export interface EnrollDestinations {
  enrolled: boolean
  device_token?: Record<string, unknown>
  destinations?: {
    has_email: boolean
    has_sms: boolean
    email: string | null
    sms: string | null
  }
}

export interface EnrollResult {
  device_token: Record<string, unknown>
}

// The one and only backend: the hosted proxy, matching the single domain in
// app.json's network whitelist. VITE_BACKEND_URL is a dev-only override for
// the simulator + fake backend — never set it when packing a distributable.
export const PROXY_URL: string =
  import.meta.env.VITE_BACKEND_URL ?? 'https://car-proxy.berrydev.co.uk'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

// Generous because a session-cache miss makes the proxy do a full Connected
// Services login, which retries transient EU-endpoint rejections with up to
// ~10 s of backoff before answering.
const TIMEOUT_MS = 65_000

export class TimeoutError extends Error {}

// Force refresh (/refresh) is deliberately absent: it must never be
// triggerable from the glasses. It remains reachable via the API directly
// per the HUD design rules.
export class BackendClient {
  constructor(private credentials: Credentials) {}

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(PROXY_URL.replace(/\/$/, '') + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new ApiError(res.status, await res.text().catch(() => res.statusText))
      }
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError(`no response within ${timeoutMs / 1000}s`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** Every car endpoint is a POST with the credentials in the body. */
  private post<T>(path: string, extra: Record<string, unknown> = {}): Promise<T> {
    return this.request(path, 'POST', { credentials: this.credentials, ...extra })
  }

  getStatus(): Promise<VehicleStatus> {
    return this.post('/status')
  }

  lock(): Promise<void> {
    return this.post('/lock')
  }

  unlock(): Promise<void> {
    return this.post('/unlock')
  }

  climate(on: boolean, temp: number, defrost: boolean, heating: boolean): Promise<void> {
    return this.post('/climate', { on, temp, defrost, heating })
  }

  charge(on: boolean): Promise<void> {
    return this.post('/charge', { on })
  }

  setChargeLimits(ac: number, dc: number): Promise<void> {
    return this.post('/charge-limits', { ac, dc })
  }

  // -- Kia-US OTP enrollment -----------------------------------------------

  enrollStart(notifyType: 'EMAIL' | 'SMS'): Promise<EnrollDestinations> {
    return this.post('/kia-us/enroll/start', { notify_type: notifyType })
  }

  enrollVerify(code: string): Promise<EnrollResult> {
    return this.post('/kia-us/enroll/verify', { code })
  }

  // -- Diagnostics -------------------------------------------------------------

  /** Raw vehicle fields from the library, server-side redacted. Used by the
   *  "Copy diagnostic report" feature so non-technical testers can paste a
   *  field dump without touching a terminal. */
  getDebugFields(): Promise<Record<string, unknown>> {
    return this.post('/debug/fields')
  }

  // Unauthenticated liveness probe — distinguishes "proxy down/no internet"
  // from "credentials wrong" in the settings Test connection flow.
  healthz(timeoutMs?: number): Promise<void> {
    return this.request('/healthz', 'GET', undefined, timeoutMs)
  }
}
