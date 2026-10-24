import path from 'node:path';

import {
  defaultDbPath,
  migrationsDir,
} from '@actual-app/core/default-filesystem';
import { vi } from 'vitest';

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

// packages/api's tests also set `IS_TESTING`, which freezes loot-core's idea of
// "today" at 2017-01-01 so its snapshots stay stable. Here that would only make
// loot-core disagree with the real clock the server runs on, so it is left unset.
