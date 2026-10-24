import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as api from '@actual-app/api';
import { defaultDbPath } from '@actual-app/core/default-filesystem';

import { createSession } from '#actual/session';
import type { ActualContext, Session, SessionHooks } from '#actual/session';

const BUDGET_ID = 'test-budget';
const BUDGET_NAME = 'Default Test Db';

export type TestHooks = {
  hooks: SessionHooks;
  /** Number of times the (stubbed) server sync was invoked. */
  syncCount: () => number;
  dispose: () => Promise<void>;
};

/**
 * Hooks that open a copy of loot-core's template budget, so tests exercise the
 * real `@actual-app/api`. Only the server sync is stubbed: there is no sync
 * server in tests.
 */
export async function createTestHooks(): Promise<TestHooks> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'actual-mcp-test-'));
  const budgetDir = path.join(dataDir, BUDGET_ID);
  const templateDir = path.join(
    path.dirname(defaultDbPath),
    'src/mocks/files/default-budget-template',
  );
  await mkdir(budgetDir);
  for (const file of ['metadata.json', 'db.sqlite']) {
    await copyFile(path.join(templateDir, file), path.join(budgetDir, file));
  }

  let syncs = 0;
  return {
    hooks: {
      async connect() {
        const lootCore = await api.init({ dataDir, verbose: false });
        await api.loadBudget(BUDGET_ID);
        return { budgetId: BUDGET_ID, budgetName: BUDGET_NAME, lootCore };
      },
      async sync() {
        syncs++;
      },
      shutdown: () => api.shutdown(),
    },
    syncCount: () => syncs,
    async dispose() {
      await api.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export type TestBudget = {
  session: Session;
  /** Runs `fn` against the loaded budget, e.g. to seed fixture data. */
  use: <T>(fn: (ctx: ActualContext) => Promise<T>) => Promise<T>;
  syncCount: () => number;
  dispose: () => Promise<void>;
};

export async function createTestBudget({
  today,
}: {
  /** Freezes the session's clock at noon on this `YYYY-MM-DD` day. */
  today?: string;
} = {}): Promise<TestBudget> {
  const { hooks, syncCount, dispose } = await createTestHooks();
  const session = createSession({
    ...hooks,
    retryDelaysMs: [],
    ...(today ? { now: () => new Date(`${today}T12:00:00`).getTime() } : {}),
  });
  return {
    session,
    use: fn => session.run('read', fn),
    syncCount,
    async dispose() {
      await session.close();
      await dispose();
    },
  };
}
