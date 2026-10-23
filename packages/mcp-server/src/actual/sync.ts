export type SyncStatus = {
  /** Epoch milliseconds of the last successful sync, or null before the first. */
  lastSyncedAt: number | null;
  /** Message from the most recent failed sync, cleared by the next success. */
  lastError: string | null;
};

export type SyncController = {
  /** Records a sync that happened outside the controller (e.g. the download). */
  markSynced: () => void;
  /**
   * Pulls remote changes unless a sync was attempted recently. Never throws:
   * reads can still be answered from the local copy, and the failure is
   * surfaced through `status()`.
   */
  beforeRead: () => Promise<void>;
  /** Pushes local changes. Throws if the server cannot be reached. */
  afterWrite: () => Promise<void>;
  status: () => SyncStatus;
};

type SyncControllerOptions = {
  sync: () => Promise<void>;
  /** Minimum time between read-triggered sync attempts. */
  intervalMs?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
};

export const DEFAULT_SYNC_INTERVAL_MS = 30_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSyncController({
  sync,
  intervalMs = DEFAULT_SYNC_INTERVAL_MS,
  now = Date.now,
  onWarning,
}: SyncControllerOptions): SyncController {
  const status: SyncStatus = { lastSyncedAt: null, lastError: null };
  // Failed attempts count too, so an unreachable server is not retried (and
  // waited on) by every single read.
  let lastAttemptAt: number | null = null;

  async function attempt() {
    lastAttemptAt = now();
    try {
      await sync();
    } catch (error) {
      status.lastError = describeError(error);
      throw error;
    }
    status.lastSyncedAt = now();
    status.lastError = null;
  }

  return {
    markSynced() {
      lastAttemptAt = now();
      status.lastSyncedAt = lastAttemptAt;
      status.lastError = null;
    },

    async beforeRead() {
      if (lastAttemptAt !== null && now() - lastAttemptAt < intervalMs) return;
      try {
        await attempt();
      } catch (error) {
        onWarning?.(
          `Sync failed, answering from the local copy: ${describeError(error)}`,
        );
      }
    },

    async afterWrite() {
      try {
        await attempt();
      } catch (error) {
        throw new Error(
          `The change was saved locally but could not be synced to the server (${describeError(error)}). It will be pushed on the next successful sync.`,
          { cause: error },
        );
      }
    },

    status: () => ({ ...status }),
  };
}
