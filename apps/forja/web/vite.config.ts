import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * SPA da Forja (specs/forja/01 §2, §12). Em dev, o Vite sobe em
 * `127.0.0.1:5173` e faz proxy de `/api` (HTTP, SSE e o WebSocket do PTY) para
 * o Fastify em `127.0.0.1:4317`. `changeOrigin` reescreve o Host para o do
 * Fastify (que só aceita `127.0.0.1:4317`/`localhost:4317`, 05 §7.1); o
 * `Origin` 5173 continua o do navegador e só é aceito com `FORJA_MODO=dev`.
 * Em produção, o build vai para `web/dist` e é servido pelo próprio Fastify.
 */
const raiz = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: raiz,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@comum': fileURLToPath(new URL('../comum', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // App local servido de 127.0.0.1: um bundle único é aceitável (sem rede no meio).
    chunkSizeWarningLimit: 2000,
  },
});
