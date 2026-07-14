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
 * Besides copy, this carries the numeric brand code the proxy passes to
 * hyundai_kia_connect_api — the proxy is stateless, so the code must ride
 * along with the credentials in every request. Verified against lib 4.15.0:
 * 1=Kia 2=Hyundai 3=Genesis.
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
  /** hyundai_kia_connect_api brand code, sent with every proxy request. */
  apiBrandCode: number
}

const BRANDS: Record<BrandId, Brand> = {
  genesis: {
    id: 'genesis',
    name: 'Genesis',
    serviceName: 'Genesis Connected Services',
    appName: 'Genesis Remote',
    apiBrandCode: 3,
  },
  kia: {
    id: 'kia',
    name: 'Kia',
    serviceName: 'Kia Connect',
    appName: 'Kia Remote',
    apiBrandCode: 1,
  },
  hyundai: {
    id: 'hyundai',
    name: 'Hyundai',
    serviceName: 'Bluelink',
    appName: 'Hyundai Remote',
    apiBrandCode: 2,
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
    const value = key && key in BRAND ? BRAND[key] : undefined
    // Copy keys only — data-brand="apiBrandCode" would be a mistake.
    if (typeof value === 'string') {
      el.textContent = value
    } else {
      console.warn(`unknown data-brand key: ${key}`)
    }
  }
}
