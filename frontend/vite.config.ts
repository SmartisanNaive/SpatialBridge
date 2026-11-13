import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the local backend; override the target with
// SPATIALBRIDGE_API_URL when the backend runs on another host or port.
const apiTarget = process.env.SPATIALBRIDGE_API_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {port: 5173, allowedHosts: true, proxy: {'/api': apiTarget}},
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          antd: ['antd', '@ant-design/icons'],
          viewer: ['openseadragon'],
        },
      },
    },
  },
});
