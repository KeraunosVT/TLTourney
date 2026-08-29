import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The weapon → class table lives in shared/ and is read by both halves.
      // One copy: two would drift, and the drift would be silent.
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    // shared/ sits outside Vite's root (frontend/), so the dev server has to be
    // told it may read it.
    fs: { allow: ['..'] },
    // Every API call is a relative '/api/...' with no axios baseURL — right in
    // production, where one process serves both. Proxying makes dev
    // same-origin too, so the session cookie flows and CORS_ORIGINS isn't
    // needed either.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: false, // keep the Host header so the session cookie matches
      },
    },
  },
  // shared/classes.cjs is CommonJS so the backend can require() it on any Node
  // version. Rollup only converts CommonJS inside node_modules by default, so
  // it has to be told about this one.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    commonjsOptions: { include: [/shared/, /node_modules/] },
  },
  optimizeDeps: {
    // Same file, dev server side: pre-bundle it so `import` of a CommonJS
    // module works under `vite dev` too, not only in a production build.
    include: [
      '@shared/classes.cjs', '@shared/roles.cjs',
      '@shared/captains.cjs', '@shared/board.cjs', '@shared/scoreboard.cjs',
    ],
    entries: ['src/**/*.jsx'],
  },
});
