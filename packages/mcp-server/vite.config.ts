import path from 'path';

import { defineConfig } from 'vite';

// Only `@actual-app/api` is kept external: it ships its own CJS bundle (with
// better-sqlite3 left external) and has to be built separately. Everything else
// listed in `dependencies` is externalized by Vite's SSR build by default, and
// the workspace-only `@actual-app/core` helpers are bundled in.
export default defineConfig({
  ssr: { external: ['@actual-app/api'] },
  build: {
    ssr: true,
    target: 'node22',
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        banner: chunk => (chunk.isEntry ? '#!/usr/bin/env node' : ''),
      },
    },
  },
});
