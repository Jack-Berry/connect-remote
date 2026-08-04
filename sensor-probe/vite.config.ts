import { defineConfig } from 'vite'

export default defineConfig({
  // allowedHosts: dev-only tunnel for phone sideload testing. Note that the
  // sensor answers this probe exists to find CANNOT be trusted from a
  // sideload — geolocation only works in a Hub build. The dev server is for
  // layout iteration only.
  server: { host: true, port: 5173, allowedHosts: ['.trycloudflare.com'] },
  build: { target: 'esnext' },
})
