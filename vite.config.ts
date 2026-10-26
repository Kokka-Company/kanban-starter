import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The kanban app talks only to its own API (api/scripts/dev-server.mjs on :7072),
// and never imports api/ files, so the whole /api prefix can be proxied.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:7072', changeOrigin: true },
    },
  },
});
