import { z } from 'zod';

import { connectTestClient } from '#testing/client';
import { seedFixture } from '#testing/fixture';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

let budget: TestBudget;
let grantId: string;
let connection: Awaited<ReturnType<typeof connectTestClient>>;

// Vest dates must be in the future for loot-core to give them schedules; it
// reads the real clock when deciding that.
const FAR_FUTURE_YEAR = new Date().getFullYear() + 2;
const VEST_DATES = [
  `${FAR_FUTURE_YEAR}-01-15`,
  `${FAR_FUTURE_YEAR}-04-15`,
  `${FAR_FUTURE_YEAR}-07-15`,
];

beforeAll(async () => {
  budget = await createTestBudget();
  grantId = await budget.use(async ctx => {
    const fixture = await seedFixture(ctx);
    const payeeId = await ctx.api.createPayee({ name: 'Example Broker' });
    await ctx.lootCore.send('rsu/set-price', { ticker: 'ABCD', price: 10000 });
    return ctx.lootCore.send('rsu-grant/create', {
      grant: {
        name: 'Grant one',
        ticker: 'abcd',
        grant_date: `${FAR_FUTURE_YEAR - 1}-01-15`,
        total_shares: 30,
        account: fixture.accounts.checking,
        category: null,
        payee: payeeId,
        withholding_rate: 0.4,
      },
      events: VEST_DATES.map(vest_date => ({ vest_date, shares: 10 })),
    });
  });
  connection = await connectTestClient({ session: budget.session });
});

afterAll(async () => {
  await connection.close();
  await budget.dispose();
});

const grantsSchema = z.object({
  grants: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      ticker: z.string(),
      total_shares: z.number(),
      withholding_rate: z.number(),
      paid_out_net: z.number(),
      remaining_est_net: z.number(),
      unvalued_rows: z.number(),
      vest_events: z.array(
        z.object({
          vest_date: z.string(),
          shares: z.number(),
          vest_price: z.number().nullable(),
          est_gross: z.number().nullable(),
          est_net: z.number().nullable(),
          basis: z.enum(['actual', 'locked', 'current']).nullable(),
          actual_net: z.number().nullable(),
          schedule_id: z.string().nullable(),
        }),
      ),
    }),
  ),
  prices: z.array(
    z.object({
      ticker: z.string(),
      price: z.number(),
      source: z.enum(['yahoo', 'stooq', 'manual']).nullable(),
      manual_override: z.boolean(),
    }),
  ),
});

const refreshSchema = z.object({
  tickers: z.array(z.string()),
  updated: z.array(z.string()),
  skipped: z.array(z.string()),
  failed: z.array(z.object({ symbol: z.string(), reason: z.string() })),
  locked_vests: z.number(),
  error: z.string().nullable(),
  dry_run: z.boolean(),
});

describe('get_rsu_grants', () => {
  it('lists grants with estimates in major units and their schedules', async () => {
    const { result, data, text } = await connection.call('get_rsu_grants');

    expect(result.isError).toBeFalsy();
    const parsed = grantsSchema.parse(data);
    expect(parsed.grants).toHaveLength(1);
    const [grant] = parsed.grants;
    expect(grant).toMatchObject({
      id: grantId,
      name: 'Grant one',
      ticker: 'ABCD',
      total_shares: 30,
      withholding_rate: 0.4,
      // 3 × 10 shares × $100 × 60%
      remaining_est_net: 1800,
      paid_out_net: 0,
      unvalued_rows: 0,
    });
    expect(grant.vest_events.map(row => row.vest_date)).toEqual(VEST_DATES);
    expect(grant.vest_events[0]).toMatchObject({
      shares: 10,
      vest_price: null,
      est_gross: 1000,
      est_net: 600,
      basis: 'current',
      actual_net: null,
    });
    expect(grant.vest_events.every(row => row.schedule_id)).toBe(true);
    expect(parsed.prices).toEqual([
      expect.objectContaining({
        ticker: 'ABCD',
        price: 100,
        source: 'manual',
        manual_override: true,
      }),
    ]);
    expect(text).toContain('Grant one (ABCD)');
  });

  it('shows the RSU schedules to get_schedules too', async () => {
    const { data } = await connection.call('get_schedules');
    const schedules = (data as { schedules: Array<{ name: string | null }> })
      .schedules;
    expect(
      schedules.filter(s => s.name?.startsWith('RSU · Grant one · ')),
    ).toHaveLength(3);
  });
});

describe('refresh_stock_prices', () => {
  it('previews which tickers it would fetch', async () => {
    const { result, data } = await connection.call('refresh_stock_prices', {
      force: true,
    });

    expect(result.isError).toBeFalsy();
    expect(refreshSchema.parse(data)).toEqual({
      tickers: ['ABCD'],
      updated: ['ABCD'],
      skipped: [],
      failed: [],
      locked_vests: 0,
      error: null,
      dry_run: true,
    });
  });

  it('skips manual prices unless forced', async () => {
    const { data } = await connection.call('refresh_stock_prices');
    expect(refreshSchema.parse(data)).toMatchObject({
      updated: [],
      skipped: ['ABCD'],
    });
  });

  it('reports that prices cannot be fetched without a sync server', async () => {
    const { result, data, text } = await connection.call(
      'refresh_stock_prices',
      { force: true, dry_run: false },
    );

    expect(result.isError).toBeFalsy();
    const parsed = refreshSchema.parse(data);
    expect(parsed.dry_run).toBe(false);
    expect(parsed.updated).toEqual([]);
    expect(parsed.error).not.toBeNull();
    expect(text).toMatch(/cannot be fetched|failed/);
  });
});
