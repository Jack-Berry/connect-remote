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

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

// Long enough to ride out a Render free-tier cold start (up to ~60 s wake
// before the request is even processed).
const TIMEOUT_MS = 65_000

export class TimeoutError extends Error {}

// Force refresh (/refresh) is deliberately absent: it must never be
// triggerable from the glasses. It remains reachable via the API directly
// (Siri Shortcuts, curl) per the HUD design rules.
export class BackendClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
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

  getStatus(): Promise<VehicleStatus> {
    return this.request('/status', 'GET')
  }

  lock(): Promise<void> {
    return this.request('/lock', 'POST')
  }

  unlock(): Promise<void> {
    return this.request('/unlock', 'POST')
  }

  climate(on: boolean, temp: number, defrost: boolean, heating: boolean): Promise<void> {
    return this.request('/climate', 'POST', { on, temp, defrost, heating })
  }

  charge(on: boolean): Promise<void> {
    return this.request('/charge', 'POST', { on })
  }

  setChargeLimits(ac: number, dc: number): Promise<void> {
    return this.request('/charge-limits', 'POST', { ac, dc })
  }

  // Unauthenticated liveness probe — distinguishes "backend down/URL wrong"
  // from "token wrong" in the settings Test connection flow. The wake loop
  // passes a short timeout so a dropped request during a Render cold start
  // fails fast and the next probe re-triggers the wake.
  healthz(timeoutMs?: number): Promise<void> {
    return this.request('/healthz', 'GET', undefined, timeoutMs)
  }

  // Render free tier drops/refuses the first request(s) while the instance
  // boots, so one launch-time /status fetch never reliably wakes it. Probe
  // /healthz with backoff until it answers — same idea as the phone app's
  // Test connection — before asking for real data.
  async wake(): Promise<void> {
    const delaysMs = [0, 2_000, 4_000, 8_000, 8_000]
    let lastErr: unknown = new TimeoutError('backend did not wake')
    for (const delayMs of delaysMs) {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs))
      try {
        await this.healthz(15_000)
        return
      } catch (err) {
        // 5xx during a cold start is Render's edge, not our app — keep
        // probing. 4xx is a definitive answer (bad URL/no such service)
        // that more waiting won't fix.
        if (err instanceof ApiError && err.status < 500) throw err
        lastErr = err
      }
    }
    throw lastErr
  }
}
