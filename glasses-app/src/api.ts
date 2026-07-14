export interface VehicleStatus {
  soc_percent: number | null
  range_value: number | null
  range_unit: string
  locked: boolean | null
  charging: boolean | null
  charge_eta_minutes: number | null
  climate_on: boolean | null
  doors_open: string[]
  // Car position — returned by the backend; no glasses UI consumes it yet.
  latitude: number | null
  longitude: number | null
  last_updated: string | null
  charge_limit_ac: number | null
  charge_limit_dc: number | null
  stale: boolean
}

/** Sent in every request body. The proxy is stateless: it holds no account
 * config, so username/password/PIN/region/brand ride along each time. */
export interface Credentials {
  username: string
  password: string
  pin: string
  region: number
  brand: number
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

  // Unauthenticated liveness probe — distinguishes "proxy down/no internet"
  // from "credentials wrong" in the settings Test connection flow.
  healthz(timeoutMs?: number): Promise<void> {
    return this.request('/healthz', 'GET', undefined, timeoutMs)
  }
}
