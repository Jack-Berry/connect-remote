import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

// Non-Genesis brands ship their own manifest (app.kia.json, …); alias the
// app.json import in main.ts to it so APP_VERSION (diagnostic report) reports
// the packed brand's version, not Genesis's.
const brand = process.env.VITE_BRAND ?? 'genesis'
const manifest = brand === 'genesis' ? 'app.json' : `app.${brand}.json`

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^\.\.\/app\.json$/,
        replacement: fileURLToPath(new URL(manifest, import.meta.url)),
      },
    ],
  },
  // allowedHosts: dev-only tunnel for phone sideload testing (Vite rejects
  // unknown Host headers with 403 otherwise).
  server: { host: true, port: 5173, allowedHosts: ['.trycloudflare.com'] },
  build: { target: 'esnext' },
})
