import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The browser only ever talks to one origin. Locally that means proxying /api
 * and /health to the Fastify dev server so the deployed same-origin layout and
 * local development behave identically.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Configuration lives in the gitignored .env at the repository root, so the
  // browser build reads VITE_ values from there rather than from apps/web.
  envDir: path.resolve(import.meta.dirname, '../..'),
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
