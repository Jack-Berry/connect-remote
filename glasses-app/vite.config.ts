import { defineConfig } from 'vite'

export default defineConfig({
  // allowedHosts: dev-only tunnel for phone sideload testing (Vite rejects
  // unknown Host headers with 403 otherwise).
  server: { host: true, port: 5173, allowedHosts: ['.trycloudflare.com'] },
  build: { target: 'esnext' },
})
