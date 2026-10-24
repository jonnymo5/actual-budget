import { peggyLoader } from '@actual-app/vite-plugin-peggy';
import { defineConfig } from 'vitest/config';

// Tests run the real `@actual-app/api` from source, exactly like
// packages/api does, so they need the same `api` export condition and the
// peggy loader that loot-core's grammar files go through.
export default defineConfig({
  plugins: [peggyLoader()],
  resolve: {
    conditions: ['api', 'development'],
  },
  ssr: {
    resolve: { conditions: ['api', 'development'] },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['src/testing/setup.ts'],
    // Each file that boots a budget loads it and runs every DB migration,
    // which is slow on busy CI runners.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    onConsoleLog(_log: string, type: 'stdout' | 'stderr'): boolean | void {
      // print only console.error
      return type === 'stderr';
    },
    maxWorkers: 2,
    reporters: process.env.CI
      ? [
          'default',
          [
            'junit',
            { outputFile: './test-results/junit.xml', suiteName: 'mcp-server' },
          ],
        ]
      : ['default'],
  },
});
