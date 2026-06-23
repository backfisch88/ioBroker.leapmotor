import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../admin/tab',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'tab.js',
        chunkFileNames: 'tab-[name].js',
        assetFileNames: 'tab-[name].[ext]',
      },
    },
  },
  server: {
    port: 4173,
    proxy: {
      '/socket.io': { target: 'http://localhost:8081', ws: true },
      '/adapter': { target: 'http://localhost:8081' },
    },
  },
});
