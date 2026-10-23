import { mkdir } from 'node:fs/promises';

import * as api from '@actual-app/api';

import type { Config } from '#config';

import { createSession } from './session';
import type { Session } from './session';

type ConnectionConfig = Pick<
  Config,
  'serverUrl' | 'serverPassword' | 'syncId' | 'encryptionPassword' | 'dataDir'
>;

async function openConfiguredBudget(config: ConnectionConfig) {
  // The API requires the data directory to exist already.
  await mkdir(config.dataDir, { recursive: true });

  await api.init({
    dataDir: config.dataDir,
    serverURL: config.serverUrl,
    password: config.serverPassword,
    // Keeps loot-core's informational logging off stdout, which carries the
    // MCP protocol.
    verbose: false,
  });

  // Registers the encryption key when there is one, and when the budget is
  // already on disk just loads and syncs it instead of downloading it again.
  await api.downloadBudget(config.syncId, {
    password: config.encryptionPassword,
  });

  const budgets = await api.getBudgets();
  const match = budgets.find(
    budget =>
      typeof budget.id === 'string' &&
      (budget.groupId === config.syncId ||
        budget.cloudFileId === config.syncId),
  );
  if (!match?.id) {
    throw new Error(
      `Downloaded the budget but could not find it on disk for sync id ${config.syncId}.`,
    );
  }
  return { budgetId: match.id, budgetName: match.name };
}

// Errors from the API name the reason but not the server, which makes
// "network-failure" hard to act on.
async function openWithContext(config: ConnectionConfig) {
  try {
    return await openConfiguredBudget(config);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason} (server: ${config.serverUrl})`, {
      cause: error,
    });
  }
}

/** The session used when running for real: one budget on a sync server. */
export function createActualSession(
  config: ConnectionConfig,
  log?: (message: string) => void,
): Session {
  return createSession({
    connect: () => openWithContext(config),
    sync: () => api.sync(),
    shutdown: () => api.shutdown(),
    log,
  });
}
