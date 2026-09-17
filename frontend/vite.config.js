import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },

  server: {
    port: 5173,
    // Proxy to the API in dev so the browser sees one origin. Without this the
    // session cookie is cross-site and `sameSite: 'lax'` drops it — which
    // presents as "login succeeds, then everything 401s".
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/healthz': 'http://127.0.0.1:3000',
      '/readyz': 'http://127.0.0.1:3000',
    },
  },

  build: {
    // The Express process serves this directory (see server.js).
    outDir: 'dist',
    // Cheap early warning: this app has no business shipping a large bundle,
    // and the warning is what catches an accidental heavy import.
    chunkSizeWarningLimit: 250,
    rollupOptions: {
      output: {
        // Vendor split so an app-code deploy does not invalidate the framework
        // chunk in every operator's browser cache.
        //
        // The function form, not the `{ vendor: [...] }` object form: Vite 8
        // bundles with rolldown, which only accepts a function here.
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
})
