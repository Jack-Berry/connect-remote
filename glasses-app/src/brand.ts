/**
 * Build-time brand configuration.
 *
 * One codebase, one app per brand. The brand is chosen at build time with
 * VITE_BRAND (defaults to `genesis`); everything brand-specific that the user
 * can see is defined here and nowhere else, so packing a Kia or Hyundai build
 * means setting one env var, not editing copy across files:
 *
 *   VITE_BRAND=kia npm run build
 *
 * Brand-specific copy in index.html is marked `data-brand="<key>"` and filled
 * from this object at boot (see applyBrand), so adding a new brand-specific
 * string needs no code change here.
 *
 * NOTE: this drives *copy only*. The numeric brand code that the vehicle API
 * needs lives in the backend (`CONNECT_REMOTE_BRAND`) alongside the
 * credentials it authenticates with — deliberately not duplicated here, so the
 * two can't drift.
 */

export type BrandId = 'genesis' | 'kia' | 'hyundai'

export interface Brand {
  id: BrandId
  /** Manufacturer, as it appears mid-sentence: "Enter your Genesis username". */
  name: string
  /** The connected-car service's own product name — what the user signs in to. */
  serviceName: string
  /** App name: phone settings header and document title. */
  appName: string
}

const BRANDS: Record<BrandId, Brand> = {
  genesis: {
    id: 'genesis',
    name: 'Genesis',
    serviceName: 'Genesis Connected Services',
    appName: 'Genesis Remote',
  },
  kia: {
    id: 'kia',
    name: 'Kia',
    serviceName: 'Kia Connect',
    appName: 'Kia Remote',
  },
  hyundai: {
    id: 'hyundai',
    name: 'Hyundai',
    serviceName: 'Bluelink',
    appName: 'Hyundai Remote',
  },
}

const requested = import.meta.env.VITE_BRAND ?? 'genesis'

if (!(requested in BRANDS)) {
  // Fail loudly at boot rather than shipping a build with a blank brand word.
  throw new Error(
    `Unknown VITE_BRAND "${requested}". Expected one of: ${Object.keys(BRANDS).join(', ')}`,
  )
}

export const BRAND: Brand = BRANDS[requested as BrandId]

/** Fill every `data-brand="<key>"` element in the document with its brand string. */
export function applyBrand(doc: Document = document): void {
  document.title = BRAND.appName

  for (const el of doc.querySelectorAll<HTMLElement>('[data-brand]')) {
    const key = el.dataset.brand as keyof Brand | undefined
    if (key && key in BRAND) {
      el.textContent = BRAND[key]
    } else {
      console.warn(`unknown data-brand key: ${key}`)
    }
  }
}
