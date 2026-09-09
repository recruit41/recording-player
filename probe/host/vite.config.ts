import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'fixtures',
  esbuild: { jsx: 'automatic' },
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
});
