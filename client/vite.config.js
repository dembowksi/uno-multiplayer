import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Configurazione di Vite.
 */
export default defineConfig({
  plugins: [react()],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  },

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5678',
        changeOrigin: true,
        timeout: 60000,
        proxyTimeout: 60000
      }
    }
  }
});
