import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// UI source lives in ui/, builds to public/ which the API server serves as static files.
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  // assetsInlineLimit 0: every font is a same-origin file, so the CSP can stay `font-src 'self'` (no data: URIs).
  build: { outDir: '../public', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
