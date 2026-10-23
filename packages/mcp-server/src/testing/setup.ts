import path from 'node:path';

import {
  defaultDbPath,
  migrationsDir,
} from '@actual-app/core/default-filesystem';
import { vi } from 'vitest';

declare global {
  var IS_TESTING: boolean;
}

// Tests run loot-core from source, but its API filesystem module locates the
// migrations and default database relative to a built `dist/` folder. Point it
// at the real files instead; this is the same mock packages/api uses.
vi.mock('@actual-app/core/platform/server/fs', async importOriginal => {
  const original = (await importOriginal()) as Record<string, unknown>;
  const lootCoreRoot = path.dirname(defaultDbPath);
  return {
    ...original,
    migrationsPath: migrationsDir,
    bundledDatabasePath: defaultDbPath,
    demoBudgetPath: path.join(lootCoreRoot, 'demo-budget'),
  };
});

globalThis.IS_TESTING = true;
