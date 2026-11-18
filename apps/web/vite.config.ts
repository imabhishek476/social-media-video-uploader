import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard proxies /api to the Express API so the session
// cookie is same-origin (SameSite=strict) and no CORS is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
});
