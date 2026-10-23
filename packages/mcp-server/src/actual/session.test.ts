import { createTestHooks } from '#testing/harness';
import type { TestHooks } from '#testing/harness';

import { createSession, isTransientError } from './session';

// What the API reports when the sync server cannot be reached.
const NETWORK_DOWN = 'Authentication failed: network-failure';

let harness: TestHooks;

beforeEach(async () => {
  harness = await createTestHooks();
});

afterEach(async () => {
  await harness.dispose();
});

describe('opening the budget', () => {
  it('waits for the first call and then opens it only once', async () => {
    const connect = vi.fn(harness.hooks.connect);
    const session = createSession({ ...harness.hooks, connect });

    expect(connect).not.toHaveBeenCalled();
    await session.run('read', async () => undefined);
    await session.run('read', async () => undefined);
    expect(connect).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it('gives the handler the open budget and a converter for its currency', async () => {
    const session = createSession(harness.hooks);

    const accounts = await session.run('read', async ctx => ({
      budget: ctx.budget,
      decimalPlaces: ctx.amounts.decimalPlaces,
      accounts: await ctx.api.getAccounts(),
    }));

    expect(accounts.budget).toEqual({
      id: 'test-budget',
      name: 'Default Test Db',
    });
    expect(accounts.decimalPlaces).toBe(2);
    expect(accounts.accounts.map(account => account.name)).toEqual([
      'Checking',
    ]);

    await session.close();
  });

  it('retries a failed open and carries on once it works', async () => {
    let failures = 2;
    const shutdown = vi.fn(harness.hooks.shutdown);
    const log: string[] = [];
    const session = createSession({
      ...harness.hooks,
      shutdown,
      async connect() {
        if (failures-- > 0) throw new Error(NETWORK_DOWN);
        return harness.hooks.connect();
      },
      retryDelaysMs: [0, 0],
      log: message => log.push(message),
    });

    await expect(
      session.run('read', async ctx => ctx.budget.name),
    ).resolves.toBe('Default Test Db');

    expect(log).toHaveLength(2);
    expect(log[0]).toContain(NETWORK_DOWN);
    // The API is a singleton, so every failed attempt resets it.
    expect(shutdown).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('fails with an actionable error after the last retry, then tries again on the next call', async () => {
    let reachable = false;
    const session = createSession({
      ...harness.hooks,
      async connect() {
        if (!reachable) throw new Error(NETWORK_DOWN);
        return harness.hooks.connect();
      },
      retryDelaysMs: [0, 0],
    });

    await expect(session.run('read', async () => 'unused')).rejects.toThrow(
      `Could not open the Actual budget after 3 attempts: ${NETWORK_DOWN}`,
    );

    reachable = true;
    await expect(
      session.run('read', async ctx => ctx.budget.name),
    ).resolves.toBe('Default Test Db');

    await session.close();
  });
});

describe('failures that retrying cannot fix', () => {
  // Repeated logins only trip the sync server's rate limiter, which then hides
  // the real cause, so a bad password or sync id must fail on the first try.
  it.each([
    'Authentication failed: invalid-password',
    'Authentication failed: too-many-requests',
    'Budget "abc" not found. Check the sync id of your budget.',
  ])('gives up straight away on: %s', async reason => {
    const connect = vi.fn(async () => {
      throw new Error(reason);
    });
    const shutdown = vi.fn(harness.hooks.shutdown);
    const session = createSession({
      ...harness.hooks,
      connect,
      shutdown,
      retryDelaysMs: [0, 0],
    });

    await expect(session.run('read', async () => 'unused')).rejects.toThrow(
      `Could not open the Actual budget: ${reason}`,
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not ask the server again for a while, then tries again once the cooldown is over', async () => {
    let passwordFixed = false;
    let clock = 1_000_000;
    const connect = vi.fn(async () => {
      if (!passwordFixed) {
        throw new Error('Authentication failed: invalid-password');
      }
      return harness.hooks.connect();
    });
    const session = createSession({
      ...harness.hooks,
      connect,
      hardFailureCooldownMs: 300_000,
      now: () => clock,
    });
    const attempt = () => session.run('read', async ctx => ctx.budget.name);

    await expect(attempt()).rejects.toThrow('invalid-password');
    expect(connect).toHaveBeenCalledTimes(1);

    // Calls during the cooldown get the same reason, without a login attempt.
    clock += 299_999;
    await expect(attempt()).rejects.toThrow(
      /invalid-password.*not asking the server again yet/,
    );
    expect(connect).toHaveBeenCalledTimes(1);

    passwordFixed = true;
    clock += 1;
    await expect(attempt()).resolves.toBe('Default Test Db');
    expect(connect).toHaveBeenCalledTimes(2);

    await session.close();
  });

  it('does not cool down after a network failure, which costs the server nothing', async () => {
    const connect = vi.fn(async () => {
      throw new Error(NETWORK_DOWN);
    });
    const session = createSession({
      ...harness.hooks,
      connect,
      retryDelaysMs: [],
    });

    await expect(session.run('read', async () => 1)).rejects.toThrow(
      NETWORK_DOWN,
    );
    await expect(session.run('read', async () => 1)).rejects.toThrow(
      NETWORK_DOWN,
    );
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('still retries when the caller says a failure is worth retrying', async () => {
    const connect = vi.fn(async () => {
      throw new Error('flaky');
    });
    const session = createSession({
      ...harness.hooks,
      connect,
      retryDelaysMs: [0, 0],
      shouldRetry: () => true,
    });

    await expect(session.run('read', async () => 'unused')).rejects.toThrow(
      'Could not open the Actual budget after 3 attempts: flaky',
    );
    expect(connect).toHaveBeenCalledTimes(3);
  });
});

describe('isTransientError', () => {
  it.each([
    'Authentication failed: network-failure',
    'connect ECONNREFUSED 127.0.0.1:5006',
    'getaddrinfo ENOTFOUND actual-server',
    'fetch failed',
  ])('retries "%s"', reason => {
    expect(isTransientError(new Error(reason))).toBe(true);
  });

  it.each([
    'Authentication failed: invalid-password',
    'Authentication failed: too-many-requests',
    'Budget "abc" not found.',
    'Could not decrypt the budget: wrong key',
  ])('does not retry "%s"', reason => {
    expect(isTransientError(new Error(reason))).toBe(false);
  });

  it('copes with errors that are not Error objects', () => {
    expect(isTransientError('network-failure')).toBe(true);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe('serialising access', () => {
  it('runs one call at a time even when several are started together', async () => {
    const session = createSession(harness.hooks);
    let running = 0;
    let peak = 0;

    const slowCall = () =>
      session.run('read', async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 10));
        running--;
      });
    await Promise.all([slowCall(), slowCall(), slowCall()]);

    expect(peak).toBe(1);
    await session.close();
  });

  it('keeps serving calls after one fails', async () => {
    const session = createSession(harness.hooks);

    await expect(
      session.run('read', async () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    await expect(session.run('read', async () => 'fine')).resolves.toBe('fine');

    await session.close();
  });
});

describe('syncing', () => {
  it('does not sync a read straight after opening, but does once the interval has passed', async () => {
    let clock = 1_000_000;
    const session = createSession({
      ...harness.hooks,
      syncIntervalMs: 30_000,
      now: () => clock,
    });

    await session.run('read', async () => undefined);
    expect(harness.syncCount()).toBe(0);

    clock += 29_999;
    await session.run('read', async () => undefined);
    expect(harness.syncCount()).toBe(0);

    clock += 1;
    await session.run('read', async () => undefined);
    expect(harness.syncCount()).toBe(1);

    await session.close();
  });

  it('pushes after every successful write', async () => {
    const session = createSession(harness.hooks);

    await session.run('write', async () => undefined);
    expect(harness.syncCount()).toBe(1);
    await session.run('write', async () => undefined);
    expect(harness.syncCount()).toBe(2);

    await session.close();
  });

  it('still pushes when a write fails part-way, and reports the original failure', async () => {
    const session = createSession(harness.hooks);

    await expect(
      session.run('write', async () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(harness.syncCount()).toBe(1);

    await session.close();
  });

  it('tells the caller when a write could not be pushed', async () => {
    const session = createSession({
      ...harness.hooks,
      sync: async () => {
        throw new Error('server unreachable');
      },
    });

    await expect(session.run('write', async () => 'done')).rejects.toThrow(
      /saved locally but could not be synced.*server unreachable/,
    );

    await session.close();
  });

  it('answers a read from the local copy when the server is unreachable, and says so in the status', async () => {
    let clock = 1_000_000;
    const session = createSession({
      ...harness.hooks,
      sync: async () => {
        throw new Error('server unreachable');
      },
      now: () => clock,
    });
    await session.run('read', async () => undefined);

    clock += 60_000;
    const status = await session.run('read', async ctx => ctx.syncStatus());

    expect(status.lastError).toBe('server unreachable');
    await session.close();
  });
});

describe('close', () => {
  it('closes the budget once, however many times it is called', async () => {
    const shutdown = vi.fn(harness.hooks.shutdown);
    const session = createSession({ ...harness.hooks, shutdown });
    await session.run('read', async () => undefined);

    await session.close();
    await session.close();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the budget was never opened', async () => {
    const shutdown = vi.fn(harness.hooks.shutdown);
    const session = createSession({ ...harness.hooks, shutdown });

    await session.close();

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('waits for a call that is still running', async () => {
    const session = createSession(harness.hooks);
    const events: string[] = [];

    const running = session.run('read', async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      events.push('call finished');
    });
    const closing = session.close().then(() => events.push('closed'));
    await Promise.all([running, closing]);

    expect(events).toEqual(['call finished', 'closed']);
  });
});
