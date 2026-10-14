import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Three separate pages, one per role. They share components but ship as
// independent bundles so a player's phone never downloads the host screen.
export default defineConfig({
  root: 'src/client',
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    target: 'es2019', // Safari 13 / iPadOS 13 era tablets still parse this
    rollupOptions: {
      input: {
        player: resolve(__dirname, 'src/client/index.html'),
        host: resolve(__dirname, 'src/client/host/index.html'),
        control: resolve(__dirname, 'src/client/control/index.html'),
        author: resolve(__dirname, 'src/client/author/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/media': 'http://localhost:8080',
    },
  },
});
