import * as asyncStorage from '#platform/server/asyncStorage';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { app as schedulesApp } from '#server/schedules/app';
import { setServer } from '#server/server-config';
import { handlers } from '#server/tests/mockSyncServer';
import { loadRules } from '#server/transactions/transaction-rules';
import * as monthUtils from '#shared/months';
import { q } from '#shared/query';
import type { RuleEntity, ScheduleEntity } from '#types/models';

import {
  createGrant,
  deleteGrant,
  getRsuData,
  lockVestPrices,
  matchDeposits,
  refreshPrices,
  setPrice,
  syncSchedules,
  updateGrant,
  updateVestEvent,
} from './app';

vi.mock('#shared/months', async () => ({
  ...(await vi.importActual('#shared/months')),
  currentDay: vi.fn(),
  currentMonth: vi.fn(),
}));

const TODAY = '2025-01-10';
const mockServerHandlers = handlers as Record<
  string,
  (data: unknown) => unknown
>;
// Defined in src/mocks/setup.ts
const stepForwardInTime = (
  globalThis as unknown as { stepForwardInTime: () => void }
).stepForwardInTime;

let accountId: string;
let payeeId: string;
let categoryId: string;

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(monthUtils.currentDay).mockReturnValue(TODAY);
  vi.mocked(monthUtils.currentMonth).mockReturnValue('2025-01');
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
  schedulesApp.startServices();

  accountId = await db.insertAccount({
    name: 'Brokerage checking',
    offbudget: 0,
    closed: 0,
  });
  payeeId = await db.insertPayee({ name: 'Example Broker' });
  const groupId = await db.insertCategoryGroup({
    name: 'Income',
    is_income: 1,
  });
  categoryId = await db.insertCategory({
    name: 'Stock income',
    cat_group: groupId,
    is_income: 1,
  });
});

afterEach(async () => {
  await schedulesApp.stopServices();
  delete mockServerHandlers['/stock-quote/quotes'];
  delete mockServerHandlers['/stock-quote/history'];
  setServer('https://test.env');
});

function baseGrant(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Grant A',
    ticker: 'abcd',
    grant_date: '2024-01-15',
    total_shares: 40,
    account: accountId,
    category: categoryId,
    payee: payeeId,
    withholding_rate: 0.5,
    notes: null,
    ...overrides,
  };
}

const futureEvents = [
  { vest_date: '2025-04-15', shares: 10 },
  { vest_date: '2025-07-15', shares: 10 },
  { vest_date: '2025-10-15', shares: 10 },
  { vest_date: '2026-01-15', shares: 10 },
];

async function allSchedules(): Promise<ScheduleEntity[]> {
  const { data } = await aqlQuery(q('schedules').select('*'));
  return data as ScheduleEntity[];
}

async function ruleFor(schedule: ScheduleEntity): Promise<RuleEntity> {
  const { data } = await aqlQuery(
    q('rules').filter({ id: schedule.rule }).select('*'),
  );
  return (data as RuleEntity[])[0];
}

describe('RSU grants', () => {
  it('creates one non-posting schedule per future vest row', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    const grantId = await createGrant({
      grant: baseGrant(),
      events: futureEvents,
    });

    const schedules = await allSchedules();
    expect(schedules).toHaveLength(4);
    for (const schedule of schedules) {
      expect(schedule.posts_transaction).toBe(false);
      expect(schedule.completed).toBe(false);
      expect(schedule._payee).toBe(payeeId);
      expect(schedule._account).toBe(accountId);
      // 10 shares × $100 × (1 − 50%)
      expect(schedule._amount).toBe(50000);
      expect(schedule._amountOp).toBe('isapprox');
      expect(schedule._rsu_vest_event).toBeTruthy();
    }
    expect(schedules.map(schedule => schedule.next_date).sort()).toEqual([
      '2025-04-15',
      '2025-07-15',
      '2025-10-15',
      '2026-01-15',
    ]);
    expect(new Set(schedules.map(schedule => schedule.name)).size).toBe(4);
    expect(schedules[0].name).toMatch(/^RSU · Grant A · \d{4}-\d{2}-\d{2}$/);

    const rule = await ruleFor(schedules[0]);
    expect(rule.actions).toContainEqual(
      expect.objectContaining({
        op: 'set',
        field: 'category',
        value: categoryId,
      }),
    );

    const { events, grants } = await getRsuData();
    expect(grants[0]).toMatchObject({ id: grantId, ticker: 'ABCD' });
    expect(events.every(event => event.schedule != null)).toBe(true);
  });

  it('waits for a price before creating schedules', async () => {
    const grantId = await createGrant({
      grant: baseGrant(),
      events: futureEvents,
    });
    expect(await allSchedules()).toHaveLength(0);

    const result = await syncSchedules({ grantId });
    expect(result.skipped.missingPrice).toHaveLength(4);

    await setPrice({ ticker: 'ABCD', price: 20000 });
    const schedules = await allSchedules();
    expect(schedules).toHaveLength(4);
    expect(schedules[0]._amount).toBe(100000);
  });

  it('rewrites amounts when the price changes and leaves dates alone', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });

    await setPrice({ ticker: 'ABCD', price: 12000 });

    const schedules = await allSchedules();
    expect(schedules.map(schedule => schedule._amount)).toEqual([
      60000, 60000, 60000, 60000,
    ]);
    expect(schedules.map(schedule => schedule.next_date).sort()[0]).toBe(
      '2025-04-15',
    );
  });

  it('is idempotent', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    const grantId = await createGrant({
      grant: baseGrant(),
      events: futureEvents,
    });

    const result = await syncSchedules({ grantId });
    expect(result).toEqual({
      created: [],
      updated: [],
      deleted: [],
      skipped: { missingPrice: [], past: [] },
    });
  });

  it('moves the schedule when a vest date or share count changes', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({
      grant: baseGrant(),
      events: [{ vest_date: '2025-04-15', shares: 10 }],
    });
    const { events } = await getRsuData();

    // The view picks the newer of the base/local next dates by timestamp.
    stepForwardInTime();
    await updateVestEvent({
      id: events[0].id,
      vest_date: '2025-05-01',
      shares: 5,
    });

    const [schedule] = await allSchedules();
    expect(schedule.next_date).toBe('2025-05-01');
    expect(schedule._date).toBe('2025-05-01');
    expect(schedule._amount).toBe(25000);
    expect(schedule.name).toBe('RSU · Grant A · 2025-05-01');
  });

  it('removes schedules for rows that were taken away', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    const grantId = await createGrant({
      grant: baseGrant(),
      events: futureEvents,
    });
    const { events } = await getRsuData();
    const [removed, ...kept] = events;
    const removedSchedule = (await allSchedules()).find(
      schedule => schedule.id === removed.schedule,
    );

    await updateGrant({
      grant: { id: grantId, name: 'Grant B' },
      events: kept.map(event => ({
        id: event.id,
        vest_date: event.vest_date,
        shares: event.shares,
      })),
    });

    const schedules = await allSchedules();
    expect(schedules).toHaveLength(3);
    expect(
      schedules.every(schedule =>
        schedule.name?.startsWith('RSU · Grant B · '),
      ),
    ).toBe(true);
    const deadRule = await db.first<{ tombstone: number }>(
      'SELECT tombstone FROM rules WHERE id = ?',
      [removedSchedule!.rule],
    );
    expect(deadRule?.tombstone).toBe(1);
  });

  it('leaves paid schedules alone', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({
      grant: baseGrant(),
      events: [{ vest_date: '2025-04-15', shares: 10 }],
    });
    const [schedule] = await allSchedules();
    await db.update('schedules', { id: schedule.id, completed: 1 });

    await setPrice({ ticker: 'ABCD', price: 99900 });

    const [after] = await allSchedules();
    expect(after._amount).toBe(50000);
  });

  it('does not create schedules for rows in the past', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    const grantId = await createGrant({
      grant: baseGrant(),
      events: [
        { vest_date: '2024-10-15', shares: 10 },
        { vest_date: '2025-04-15', shares: 10 },
      ],
    });

    expect(await allSchedules()).toHaveLength(1);
    const result = await syncSchedules({ grantId });
    expect(result.skipped.past).toHaveLength(1);
  });

  it('prefers a recorded actual net over the estimate', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({
      grant: baseGrant(),
      events: [{ vest_date: '2025-04-15', shares: 10 }],
    });
    const { events } = await getRsuData();

    await updateVestEvent({ id: events[0].id, actual_net: 43210 });

    const [schedule] = await allSchedules();
    expect(schedule._amount).toBe(43210);
  });

  it('suffixes names that are already taken', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({
      grant: baseGrant(),
      events: [
        { vest_date: '2025-04-15', shares: 10 },
        { vest_date: '2025-04-15', shares: 5 },
      ],
    });

    const names = (await allSchedules()).map(schedule => schedule.name).sort();
    expect(names).toEqual([
      'RSU · Grant A · 2025-04-15',
      'RSU · Grant A · 2025-04-15 (2)',
    ]);
  });

  it('deletes a grant together with its unpaid schedules', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    const grantId = await createGrant({
      grant: baseGrant(),
      events: futureEvents,
    });

    await deleteGrant({ id: grantId });

    expect(await allSchedules()).toHaveLength(0);
    const { grants, events } = await getRsuData();
    expect(grants).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('rejects grants without the fields a schedule needs', async () => {
    await expect(
      createGrant({ grant: baseGrant({ payee: '' }) }),
    ).rejects.toThrow('A payee is required');
    await expect(
      createGrant({ grant: baseGrant({ ticker: 'not a ticker' }) }),
    ).rejects.toThrow('Enter a valid ticker symbol');
    await expect(
      createGrant({ grant: baseGrant({ withholding_rate: 1 }) }),
    ).rejects.toThrow('Withholding must be between 0% and 99%');
  });
});

describe('refreshPrices', () => {
  it('reports when no server is configured', async () => {
    await createGrant({ grant: baseGrant(), events: futureEvents });
    setServer(null as unknown as string);

    const result = await refreshPrices();
    expect(result.error).toBe('no-server');
    expect(result.skipped).toEqual(['ABCD']);
  });

  it('reports when the user is not logged in', async () => {
    await createGrant({ grant: baseGrant(), events: futureEvents });
    vi.mocked(asyncStorage.getItem).mockResolvedValue(undefined);

    const result = await refreshPrices();
    expect(result.error).toBe('unauthorized');
  });

  it('stores quotes from the server and rewrites schedule amounts', async () => {
    await createGrant({ grant: baseGrant(), events: futureEvents });
    vi.mocked(asyncStorage.getItem).mockResolvedValue('test-token');
    const calls: unknown[] = [];
    mockServerHandlers['/stock-quote/quotes'] = (data: unknown) => {
      calls.push(data);
      return {
        quotes: [
          {
            symbol: 'ABCD',
            price: 123.45,
            currency: 'USD',
            asOf: '2025-01-10T15:00:00.000Z',
            source: 'yahoo',
          },
        ],
        errors: [{ symbol: 'ZZZZ', reason: 'not-found' }],
      };
    };

    const result = await refreshPrices();

    expect(calls).toEqual([{ symbols: ['ABCD'] }]);
    expect(result).toEqual({
      updated: ['ABCD'],
      failed: [{ symbol: 'ZZZZ', reason: 'not-found' }],
      skipped: [],
    });
    const { prices } = await getRsuData();
    expect(prices[0]).toMatchObject({
      id: 'ABCD',
      price: 12345,
      currency: 'USD',
      source: 'yahoo',
      manual_override: false,
    });
    const schedules = await allSchedules();
    expect(schedules).toHaveLength(4);
    // 10 × $123.45 × 50%
    expect(schedules[0]._amount).toBe(61725);
  });

  it('skips tickers with a manual override unless forced', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });
    vi.mocked(asyncStorage.getItem).mockResolvedValue('test-token');
    mockServerHandlers['/stock-quote/quotes'] = () => ({
      quotes: [
        { symbol: 'ABCD', price: 200, currency: 'USD', source: 'stooq' },
      ],
      errors: [],
    });

    expect(await refreshPrices()).toEqual({
      updated: [],
      failed: [],
      skipped: ['ABCD'],
    });

    const forced = await refreshPrices({ force: true });
    expect(forced.updated).toEqual(['ABCD']);
    const { prices } = await getRsuData();
    expect(prices[0]).toMatchObject({ price: 20000, manual_override: false });
  });
});

describe('lockVestPrices', () => {
  const pastEvents = [
    { vest_date: '2024-10-15', shares: 10 },
    { vest_date: '2024-11-16', shares: 10 },
  ];

  it('stores the close on each past vest date and leaves future rows alone', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    const grantId = await createGrant({
      grant: baseGrant(),
      events: [...pastEvents, { vest_date: '2025-04-15', shares: 10 }],
    });
    vi.mocked(asyncStorage.getItem).mockResolvedValue('test-token');
    const calls: unknown[] = [];
    mockServerHandlers['/stock-quote/history'] = (data: unknown) => {
      calls.push(data);
      return {
        symbol: 'ABCD',
        currency: 'USD',
        closes: [
          { date: '2024-10-15', close: 80.5, close_date: '2024-10-15' },
          { date: '2024-11-16', close: 90, close_date: '2024-11-15' },
        ],
        errors: [],
      };
    };

    const result = await lockVestPrices({ grantId });

    expect(calls).toEqual([
      { symbol: 'ABCD', dates: ['2024-10-15', '2024-11-16'] },
    ]);
    expect(result.locked).toHaveLength(2);
    expect(result.failed).toEqual([]);
    const { events } = await getRsuData();
    expect(
      events
        .map(event => [event.vest_date, event.actual_price] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ['2024-10-15', 8050],
      ['2024-11-16', 9000],
      ['2025-04-15', null],
    ]);

    // Locked rows no longer follow the quote.
    await setPrice({ ticker: 'ABCD', price: 99900 });
    const again = await lockVestPrices({ grantId });
    expect(again.locked).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reports dates the provider cannot price and a missing server', async () => {
    const grantId = await createGrant({
      grant: baseGrant(),
      events: pastEvents,
    });
    vi.mocked(asyncStorage.getItem).mockResolvedValue('test-token');
    mockServerHandlers['/stock-quote/history'] = () => ({
      symbol: 'ABCD',
      currency: 'USD',
      closes: [{ date: '2024-10-15', close: 80, close_date: '2024-10-15' }],
      errors: [{ date: '2024-11-16', reason: 'not-found' }],
    });

    const result = await lockVestPrices({ grantId });
    expect(result.locked).toHaveLength(1);
    expect(result.failed).toEqual([
      { eventId: expect.any(String), reason: 'not-found' },
    ]);

    setServer(null as unknown as string);
    const offline = await lockVestPrices({ grantId });
    expect(offline.error).toBe('no-server');
    expect(offline.failed).toHaveLength(1);
  });
});

describe('matchDeposits', () => {
  it('records the nearest deposit from the payee as the actual net', async () => {
    const grantId = await createGrant({
      grant: baseGrant(),
      events: [
        { vest_date: '2024-10-15', shares: 10 },
        { vest_date: '2024-11-15', shares: 10 },
        { vest_date: '2024-12-15', shares: 10 },
      ],
    });
    const otherPayee = await db.insertPayee({ name: 'Someone else' });
    for (const [date, amount, payee] of [
      ['2024-10-18', 61000, payeeId],
      ['2024-10-16', 500, otherPayee],
      ['2024-11-20', 59000, payeeId],
      ['2024-11-01', 1000, payeeId],
    ] as const) {
      await db.insertTransaction({
        account: accountId,
        payee,
        date,
        amount,
        cleared: true,
      });
    }

    const result = await matchDeposits({ grantId });

    expect(
      result.matched.map(match => match.amount).sort((a, b) => a - b),
    ).toEqual([59000, 61000]);
    expect(result.unmatched).toHaveLength(1);
    const { events } = await getRsuData();
    expect(
      events
        .map(event => [event.vest_date, event.actual_net] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ['2024-10-15', 61000],
      ['2024-11-15', 59000],
      ['2024-12-15', null],
    ]);

    // Already matched rows are left alone on a second run.
    expect((await matchDeposits({ grantId })).matched).toEqual([]);
  });
});
