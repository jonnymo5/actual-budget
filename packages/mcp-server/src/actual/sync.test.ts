import { createSyncController } from './sync';

function setup(overrides: { sync?: () => Promise<void> } = {}) {
  let clock = 1_000_000;
  const sync = vi.fn(overrides.sync ?? (async () => undefined));
  const warnings: string[] = [];
  const controller = createSyncController({
    sync,
    intervalMs: 30_000,
    now: () => clock,
    onWarning: message => warnings.push(message),
  });
  return {
    controller,
    sync,
    warnings,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('beforeRead', () => {
  it('syncs on the first read', async () => {
    const { controller, sync } = setup();
    await controller.beforeRead();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(controller.status().lastSyncedAt).toBe(1_000_000);
  });

  it('skips the sync while the last attempt is recent, and syncs once it is not', async () => {
    const { controller, sync, advance } = setup();
    await controller.beforeRead();

    advance(29_999);
    await controller.beforeRead();
    expect(sync).toHaveBeenCalledTimes(1);

    advance(1);
    await controller.beforeRead();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does not sync right after the budget was opened', async () => {
    const { controller, sync } = setup();
    controller.markSynced();
    await controller.beforeRead();
    expect(sync).not.toHaveBeenCalled();
  });

  it('does not throw when the server is unreachable, and records why', async () => {
    const { controller, warnings } = setup({
      sync: async () => {
        throw new Error('network down');
      },
    });

    await expect(controller.beforeRead()).resolves.toBeUndefined();

    expect(controller.status()).toEqual({
      lastSyncedAt: null,
      lastError: 'network down',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('network down');
  });

  it('does not retry an unreachable server on every read', async () => {
    const { controller, sync, advance } = setup({
      sync: async () => {
        throw new Error('network down');
      },
    });

    await controller.beforeRead();
    advance(5_000);
    await controller.beforeRead();
    expect(sync).toHaveBeenCalledTimes(1);

    advance(25_000);
    await controller.beforeRead();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('clears the recorded error once a sync succeeds', async () => {
    let failing = true;
    const { controller, advance } = setup({
      sync: async () => {
        if (failing) throw new Error('network down');
      },
    });
    await controller.beforeRead();
    expect(controller.status().lastError).toBe('network down');

    failing = false;
    advance(30_000);
    await controller.beforeRead();
    expect(controller.status().lastError).toBeNull();
    expect(controller.status().lastSyncedAt).not.toBeNull();
  });
});

describe('afterWrite', () => {
  it('always syncs, even straight after a read sync', async () => {
    const { controller, sync } = setup();
    await controller.beforeRead();
    await controller.afterWrite();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('tells the caller the change is saved locally when the push fails', async () => {
    const { controller } = setup({
      sync: async () => {
        throw new Error('network down');
      },
    });

    await expect(controller.afterWrite()).rejects.toThrow(
      /saved locally but could not be synced.*network down/,
    );
    expect(controller.status().lastError).toBe('network down');
  });
});
