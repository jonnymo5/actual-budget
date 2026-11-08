import * as asyncStorage from '#platform/server/asyncStorage';
import { aqlQuery } from '#server/aql';
import { getBudget, setBudget } from '#server/budget/actions';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { runMutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import {
  createSchedule,
  app as schedulesApp,
  setScheduleCategory,
  updateSchedule,
} from '#server/schedules/app';
import { setServer } from '#server/server-config';
import { handlers } from '#server/tests/mockSyncServer';
import { loadRules } from '#server/transactions/transaction-rules';
import * as monthUtils from '#shared/months';
import { q } from '#shared/query';
import type { RecurConfig, RuleEntity, ScheduleEntity } from '#types/models';

import {
  app,
  createGrant,
  deleteGrant,
  getRsuData,
  isBudgetSyncEnabled,
  lockVestPrices,
  matchDeposits,
  refreshPrices,
  setPrice,
  syncBudget,
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

describe('syncBudget', () => {
  async function useTrackingBudget() {
    await db.update('preferences', { id: 'budgetType', value: 'tracking' });
  }

  it('budgets the summed net of every grant vesting in a month', async () => {
    await useTrackingBudget();
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });
    await createGrant({
      grant: baseGrant({ name: 'Grant B' }),
      events: [
        { vest_date: '2025-04-22', shares: 4 },
        { vest_date: '2025-05-22', shares: 2 },
      ],
    });
    // A guess typed in by hand is replaced; a past month is not touched.
    await setBudget({ category: categoryId, month: '2025-02', amount: 99900 });
    await setBudget({ category: categoryId, month: '2024-12', amount: 77700 });

    const result = await syncBudget();

    expect(result.skipped).toBeUndefined();
    // 2025-01 through 2026-01: thirteen months
    expect(result.changes.length + result.unchanged).toBe(13);
    const budgeted = (month: string) =>
      getBudget({ category: categoryId, month });
    // Grant A: 10 shares × $100 × 50%; Grant B: 4 shares the same month
    expect(budgeted('2025-04')).toBe(50000 + 20000);
    expect(budgeted('2025-05')).toBe(10000);
    expect(budgeted('2025-07')).toBe(50000);
    expect(budgeted('2026-01')).toBe(50000);
    expect(budgeted('2025-02')).toBe(0);
    expect(budgeted('2025-03')).toBe(0);
    expect(budgeted('2024-12')).toBe(77700);
    expect(result.changes).toContainEqual({
      category: categoryId,
      month: '2025-02',
      before: 99900,
      after: 0,
    });
  });

  it('writes nothing on a second run or a dry run', async () => {
    await useTrackingBudget();
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });

    const preview = await syncBudget({ dryRun: true });
    expect(preview.changes.length).toBeGreaterThan(0);
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(0);

    await syncBudget();
    const again = await syncBudget();
    expect(again.changes).toEqual([]);
    expect(again.unchanged).toBe(13);
  });

  it('follows a new share price', async () => {
    await useTrackingBudget();
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });
    await syncBudget();

    await setPrice({ ticker: 'ABCD', price: 20000 });
    await syncBudget();
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(100000);
  });

  it('leaves months with an unpriced vest alone', async () => {
    await useTrackingBudget();
    await createGrant({ grant: baseGrant(), events: futureEvents });
    await setBudget({ category: categoryId, month: '2025-04', amount: 12300 });

    const result = await syncBudget();
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(12300);
    expect(result.unpriced).toContainEqual({
      category: categoryId,
      month: '2025-04',
      ticker: 'ABCD',
    });
  });

  it('ignores grants whose category is not an income category', async () => {
    await useTrackingBudget();
    await setPrice({ ticker: 'ABCD', price: 10000 });
    const groupId = await db.insertCategoryGroup({ name: 'Spending' });
    const expenseId = await db.insertCategory({
      name: 'Groceries',
      cat_group: groupId,
    });
    const grantId = await createGrant({
      grant: baseGrant({ category: expenseId }),
      events: futureEvents,
    });

    const result = await syncBudget();
    expect(result.ignoredGrants).toEqual([grantId]);
    expect(result.changes).toEqual([]);
    expect(getBudget({ category: expenseId, month: '2025-04' })).toBe(0);
  });

  async function incomeSchedule(
    category: string | null,
    amount: number,
    date: string | RecurConfig,
  ): Promise<string> {
    const id = await createSchedule({
      conditions: [
        { op: 'is', field: 'account', value: accountId },
        { op: 'isapprox', field: 'amount', value: amount },
        { op: 'isapprox', field: 'date', value: date },
      ],
    });
    if (category) {
      await setScheduleCategory({ id, category });
    }
    return id;
  }

  it('budgets deposits from schedules tagged with an income category', async () => {
    await useTrackingBudget();
    const groupId = await db.insertCategoryGroup({
      name: 'More income',
      is_income: 1,
    });
    const bonusId = await db.insertCategory({
      name: 'Bonus',
      cat_group: groupId,
      is_income: 1,
    });
    const payrollId = await db.insertCategory({
      name: 'Payroll',
      cat_group: groupId,
      is_income: 1,
    });
    await incomeSchedule(bonusId, 300000, {
      start: '2025-04-15',
      frequency: 'yearly',
    });
    await incomeSchedule(payrollId, 50000, {
      start: '2025-01-13',
      frequency: 'monthly',
      patterns: [
        { type: 'day', value: 13 },
        { type: 'day', value: 28 },
      ],
    });
    // Neither of these is budgeted: one has no category, one is not income.
    await incomeSchedule(null, 70000, '2025-03-01');
    const spendingGroup = await db.insertCategoryGroup({ name: 'Spending' });
    const rentId = await db.insertCategory({
      name: 'Rent',
      cat_group: spendingGroup,
    });
    await incomeSchedule(rentId, -90000, {
      start: '2025-01-01',
      frequency: 'monthly',
    });
    await setBudget({ category: bonusId, month: '2025-02', amount: 4200 });

    const result = await syncBudget();

    const budgeted = (category: string, month: string) =>
      getBudget({ category, month });
    expect(budgeted(bonusId, '2025-04')).toBe(300000);
    expect(budgeted(bonusId, '2025-02')).toBe(0);
    // The yearly bonus comes round again in April 2026, past the range.
    expect(budgeted(bonusId, '2026-01')).toBe(0);
    for (const month of ['2025-01', '2025-06', '2026-01']) {
      expect(budgeted(payrollId, month)).toBe(100000);
    }
    expect(budgeted(rentId, '2025-03')).toBe(0);
    expect(budgeted(categoryId, '2025-03')).toBe(0);
    expect(result.changes.map(change => change.category)).not.toContain(rentId);
  });

  it('adds scheduled deposits to RSU vests in the same category', async () => {
    await useTrackingBudget();
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });
    await incomeSchedule(categoryId, 12300, '2025-04-30');

    await syncBudget();
    // The grant's own vest schedule is not counted a second time.
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(
      50000 + 12300,
    );
  });

  it('keeps a completed deposit from earlier this month', async () => {
    await useTrackingBudget();
    const arrived = await incomeSchedule(categoryId, 20000, '2025-01-05');
    const cancelled = await incomeSchedule(categoryId, 30000, '2025-01-20');
    await updateSchedule({ schedule: { id: arrived, completed: true } });
    await updateSchedule({ schedule: { id: cancelled, completed: true } });

    await syncBudget();
    expect(getBudget({ category: categoryId, month: '2025-01' })).toBe(20000);
  });

  it('does nothing in an envelope budget', async () => {
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });

    const result = await syncBudget();
    expect(result.skipped).toBe('envelope-budget');
    expect(result.changes).toEqual([]);
  });

  it('is turned on by a synced preference', async () => {
    expect(isBudgetSyncEnabled()).toBe(false);
    await db.update('preferences', { id: 'rsu-budget-sync', value: 'true' });
    expect(isBudgetSyncEnabled()).toBe(true);
  });
});

describe('daily RSU refresh', () => {
  async function emitSyncAndWait() {
    app.events.emit('sync', { type: 'success', tables: [] });
    // Mutators run one at a time, so this resolves after the hook's work.
    await runMutator(() => Promise.resolve());
  }

  beforeEach(async () => {
    await prefs.loadPrefs();
    await db.update('preferences', { id: 'budgetType', value: 'tracking' });
    // No server, so the hook skips prices and only rebudgets.
    setServer(null as unknown as string);
    await setPrice({ ticker: 'ABCD', price: 10000 });
    await createGrant({ grant: baseGrant(), events: futureEvents });
  });

  afterEach(() => {
    prefs.unloadPrefs();
  });

  it('rebudgets once a day when turned on', async () => {
    await db.update('preferences', { id: 'rsu-budget-sync', value: 'true' });

    await emitSyncAndWait();
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(50000);
    expect(prefs.getPrefs().lastRsuBudgetSync).toBe(TODAY);

    // Later syncs the same day leave the budget alone.
    await setBudget({ category: categoryId, month: '2025-04', amount: 1 });
    await emitSyncAndWait();
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(1);

    // The next day it runs again.
    vi.mocked(monthUtils.currentDay).mockReturnValue('2025-01-11');
    await emitSyncAndWait();
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(50000);
  });

  it('leaves the budget alone when turned off', async () => {
    await emitSyncAndWait();
    expect(getBudget({ category: categoryId, month: '2025-04' })).toBe(0);
    expect(prefs.getPrefs().lastRsuBudgetSync).toBeUndefined();
  });
});
