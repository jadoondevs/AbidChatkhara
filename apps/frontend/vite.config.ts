import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered by hand in main.tsx so a new deployment can RELOAD
      // the till rather than just installing quietly behind it — see
      // the note there.
      injectRegister: false,
      // App-shell caching only (spec): the built HTML/JS/CSS are
      // precached so a reload still works if the server blips, but API
      // responses are deliberately NOT cached — a cashier must never be
      // shown a stale order list or a bill that has since been settled
      // on another terminal.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      manifest: {
        name: 'Restaurant POS',
        short_name: 'POS',
        description: 'Local-first point-of-sale',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    // `npm run dev` in this package talks to the real server process,
    // so the dev experience matches production's single-origin setup.
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
