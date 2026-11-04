import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ command }) => ({
  root: 'src/renderer', base: './',
  plugins: [vue(), { name: 'stackmanage-csp', transformIndexHtml: html => html.replace('__CONNECT_SRC__', command === 'serve' ? "'self' ws://127.0.0.1:5179" : "'none'") }],
  server: { host: '127.0.0.1', port: 5179, strictPort: true },
  build: { outDir: '../../dist/renderer', emptyOutDir: true }
}));
