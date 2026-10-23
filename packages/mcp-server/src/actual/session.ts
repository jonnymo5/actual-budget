import * as api from '@actual-app/api';

import { createAmountConverter } from './amounts';
import type { AmountConverter } from './amounts';
import { createMutex } from './mutex';
import { createSyncController, DEFAULT_SYNC_INTERVAL_MS } from './sync';
import type { SyncStatus } from './sync';

export type ActualApi = typeof api;

/**
 * Everything a tool handler may touch. It only exists inside `Session.run`, so
 * a handler cannot reach the Actual API without holding the mutex.
 */
export type ActualContext = {
  api: ActualApi;
  amounts: AmountConverter;
  budget: { id: string; name: string };
  syncStatus: () => SyncStatus;
};

export type AccessKind = 'read' | 'write';

export type Session = {
  /**
   * Runs `fn` with exclusive access to the Actual API. Reads pull remote
   * changes first (debounced); writes also push their changes afterwards.
   */
  run: <T>(
    kind: AccessKind,
    fn: (ctx: ActualContext) => Promise<T>,
  ) => Promise<T>;
  /** Waits for in-flight calls, then closes the budget. Safe to call twice. */
  close: () => Promise<void>;
};

export type SessionHooks = {
  /** Initialises the API and opens the budget; returns what was opened. */
  connect: () => Promise<{ budgetId: string; budgetName: string }>;
  sync: () => Promise<void>;
  shutdown: () => Promise<void>;
};

type SessionOptions = SessionHooks & {
  syncIntervalMs?: number;
  /** Pause before each reconnection attempt; its length sets the retry count. */
  retryDelaysMs?: number[];
  /** Whether a failed open is worth another try. Defaults to network errors. */
  shouldRetry?: (error: unknown) => boolean;
  /** How long to refuse to reopen after a failure that retrying cannot fix. */
  hardFailureCooldownMs?: number;
  now?: () => number;
  log?: (message: string) => void;
};

export const DEFAULT_RETRY_DELAYS_MS = [500, 2_000];

// Only failures to reach the server are worth retrying. Anything else (wrong
// password, unknown sync id, wrong encryption key) will fail the same way
// again, and repeated logins just trip the sync server's rate limiter, which
// then hides the real cause.
const TRANSIENT_ERROR =
  /network-failure|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i;

// The sync server allows only a handful of failed logins per 15 minutes, so
// after a bad password the server must not be asked again on every tool call.
export const DEFAULT_HARD_FAILURE_COOLDOWN_MS = 5 * 60_000;

export function isTransientError(error: unknown): boolean {
  return TRANSIENT_ERROR.test(describeError(error));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createSession({
  connect,
  sync,
  shutdown,
  syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  shouldRetry = isTransientError,
  hardFailureCooldownMs = DEFAULT_HARD_FAILURE_COOLDOWN_MS,
  now = Date.now,
  log = () => undefined,
}: SessionOptions): Session {
  const mutex = createMutex();
  const syncController = createSyncController({
    sync,
    intervalMs: syncIntervalMs,
    now,
    onWarning: log,
  });
  let context: ActualContext | null = null;
  let hardFailure: { message: string; at: number } | null = null;

  async function openOnce(): Promise<ActualContext> {
    const { budgetId, budgetName } = await connect();
    const prefs = await api.getPreferences();
    return {
      api,
      amounts: createAmountConverter(prefs.defaultCurrencyCode),
      budget: { id: budgetId, name: budgetName },
      syncStatus: syncController.status,
    };
  }

  async function open(): Promise<ActualContext> {
    if (hardFailure && now() - hardFailure.at < hardFailureCooldownMs) {
      throw new Error(
        `${hardFailure.message} (not asking the server again yet, to stay under its login rate limit; fix the configuration and restart the MCP server to retry now)`,
      );
    }
    let lastError: unknown;
    let attempts = 0;
    for (let retry = 0; retry <= retryDelaysMs.length; retry++) {
      if (retry > 0) await sleep(retryDelaysMs[retry - 1]);
      attempts++;
      try {
        const opened = await openOnce();
        // Opening the budget downloads or syncs it, so it is fresh right now.
        syncController.markSynced();
        hardFailure = null;
        return opened;
      } catch (error) {
        lastError = error;
        log(
          `Opening the budget failed (attempt ${attempts}): ${describeError(error)}`,
        );
        // The API is a singleton: reset it so the next attempt starts clean.
        await shutdown().catch(() => undefined);
        if (!shouldRetry(error)) {
          const message = `Could not open the Actual budget: ${describeError(error)}`;
          hardFailure = { message, at: now() };
          throw new Error(message, { cause: error });
        }
      }
    }
    throw new Error(
      `Could not open the Actual budget after ${attempts} attempts: ${describeError(lastError)}`,
      { cause: lastError },
    );
  }

  return {
    run(kind, fn) {
      return mutex.runExclusive(async () => {
        context ??= await open();
        await syncController.beforeRead();
        if (kind === 'read') return fn(context);

        let result;
        try {
          result = await fn(context);
        } catch (error) {
          // The handler may have changed data before failing; push whatever
          // was saved, but report the original failure.
          await syncController.afterWrite().catch(() => undefined);
          throw error;
        }
        await syncController.afterWrite();
        return result;
      });
    },

    close() {
      return mutex.runExclusive(async () => {
        if (!context) return;
        context = null;
        await shutdown();
      });
    },
  };
}
