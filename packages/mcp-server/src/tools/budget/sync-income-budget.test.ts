import { z } from 'zod';

import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import { succeed } from '#testing/tools';

// Every test gets a budget of its own, because they all change it.
let budget: TestBudget;
let connection: Awaited<ReturnType<typeof connectTestClient>>;
let incomeCategory: string;

// loot-core decides which months are ahead with the real clock.
function monthFromNow(offset: number): string {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
const NEXT = monthFromNow(1);
const AFTER = monthFromNow(2);

const syncSchema = z.object({
  budget_type: z.enum(['tracking', 'envelope']),
  auto: z.boolean(),
  changes: z.array(
    z.object({
      category: z.string(),
      month: z.string(),
      before: z.number(),
      after: z.number(),
    }),
  ),
  unchanged: z.number(),
  unpriced: z.array(
    z.object({ category: z.string(), month: z.string(), ticker: z.string() }),
  ),
  ignored_grants: z.array(z.string()),
});

const monthSchema = z.object({
  groups: z.array(
    z.object({
      categories: z.array(
        z.object({ name: z.string(), budgeted: z.number().nullable() }),
      ),
    }),
  ),
});

beforeEach(async () => {
  budget = await createTestBudget();
  incomeCategory = await budget.use(async ctx => {
    const income = (await ctx.api.getCategoryGroups()).find(g => g.is_income);
    const category = income?.categories?.[0];
    if (!category) throw new Error('template has no income category');
    const account = await ctx.api.createAccount({ name: 'Brokerage cash' });
    const payee = await ctx.api.createPayee({ name: 'Example Broker' });
    await ctx.lootCore.send('rsu/set-price', { ticker: 'ACME', price: 10000 });
    const grant = {
      ticker: 'ACME',
      total_shares: 100,
      account,
      payee,
      category: category.id,
      withholding_rate: 0.5,
    };
    // Two grants vest in the same month, so that month budgets their sum.
    await ctx.lootCore.send('rsu-grant/create', {
      grant: { ...grant, name: 'Grant A' },
      events: [
        { vest_date: `${NEXT}-08`, shares: 10 },
        { vest_date: `${AFTER}-08`, shares: 2 },
      ],
    });
    await ctx.lootCore.send('rsu-grant/create', {
      grant: { ...grant, name: 'Grant B' },
      events: [{ vest_date: `${NEXT}-22`, shares: 4 }],
    });
    return category.name;
  });
  connection = await connectTestClient({ session: budget.session });
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

async function useTrackingBudget() {
  await budget.use(async ctx => {
    await ctx.api.setPreference('budgetType', 'tracking');
    await ctx.api.loadBudget(ctx.budget.id);
  });
}

async function budgeted(month: string): Promise<number | null> {
  const { data } = await succeed(
    connection,
    'get_budget_month',
    { month },
    monthSchema,
  );
  const found = data.groups
    .flatMap(group => group.categories)
    .find(c => c.name === incomeCategory);
  return found?.budgeted ?? null;
}

describe('sync_income_budget', () => {
  it('previews the summed vests per month and changes nothing', async () => {
    await useTrackingBudget();
    const { data, text } = await succeed(
      connection,
      'sync_income_budget',
      {},
      syncSchema,
    );

    expect(data.budget_type).toBe('tracking');
    expect(data.auto).toBe(false);
    // (10 + 4 shares) × $100 × (1 − 50%) next month; 2 shares the month after
    expect(data.changes).toEqual([
      { category: incomeCategory, month: NEXT, before: 0, after: 700 },
      { category: incomeCategory, month: AFTER, before: 0, after: 100 },
    ]);
    // Thirteen months from this one, the rest already 0.
    expect(data.unchanged).toBe(11);
    expect(text).toMatch(/Would change 2 budgeted months/);
    expect(await budgeted(NEXT)).toBe(0);
  });

  it('applies the amounts, turns on the daily sync, and is idempotent', async () => {
    await useTrackingBudget();
    const applied = await succeed(
      connection,
      'sync_income_budget',
      { auto: true, dry_run: false },
      syncSchema,
    );
    expect(applied.data.auto).toBe(true);
    expect(applied.text).toMatch(/Turned the daily budget sync on/);
    expect(await budgeted(NEXT)).toBe(700);
    expect(await budgeted(AFTER)).toBe(100);

    const prefs = await budget.use(ctx => ctx.lootCore.send('preferences/get'));
    expect(prefs['rsu-budget-sync']).toBe('true');

    const again = await succeed(
      connection,
      'sync_income_budget',
      { dry_run: false },
      syncSchema,
    );
    expect(again.data.changes).toEqual([]);
    expect(again.data.auto).toBe(true);
    expect(again.text).toMatch(/already up to date/);
  });

  it('adds deposits from schedules tagged with an income category', async () => {
    await useTrackingBudget();
    const created = await succeed(
      connection,
      'create_schedules',
      {
        schedules: [
          {
            name: 'Bonus',
            account: 'Brokerage cash',
            payee: 'Example Broker',
            amount: 1000,
            amount_match: 'approximate',
            start_date: `${AFTER}-15`,
            frequency: 'once',
            category: incomeCategory,
          },
        ],
        dry_run: false,
      },
      z.object({
        schedules: z.array(z.object({ category: z.string().nullable() })),
      }),
    );
    expect(created.data.schedules[0].category).toBe(incomeCategory);

    const { data } = await succeed(
      connection,
      'sync_income_budget',
      {},
      syncSchema,
    );
    expect(data.changes).toContainEqual({
      category: incomeCategory,
      month: AFTER,
      before: 0,
      after: 100 + 1000,
    });
  });

  it('tags and clears schedules, but not the ones RSU grants own', async () => {
    await useTrackingBudget();
    await succeed(
      connection,
      'create_schedules',
      {
        schedules: [
          {
            name: 'Side gig',
            account: 'Brokerage cash',
            payee: 'Example Broker',
            amount: 500,
            start_date: `${NEXT}-20`,
            frequency: 'once',
          },
        ],
        dry_run: false,
      },
      z.object({}),
    );
    const changeSchema = z.object({
      changes: z.array(
        z.object({
          schedule: z.string(),
          before: z.string().nullable(),
          after: z.string().nullable(),
        }),
      ),
      unchanged: z.array(z.string()),
      skipped: z.array(z.object({ schedule: z.string(), reason: z.string() })),
    });

    const tagged = await succeed(
      connection,
      'set_schedule_category',
      {
        entries: [
          { schedule: 'Side gig', category: incomeCategory },
          { schedule: `RSU · Grant A · ${NEXT}-08`, category: null },
          { schedule: 'No such schedule', category: null },
        ],
        dry_run: false,
      },
      changeSchema,
    );
    expect(tagged.data.changes).toEqual([
      { schedule: 'Side gig', before: null, after: incomeCategory },
    ]);
    expect(tagged.data.skipped.map(skip => skip.reason)).toEqual([
      expect.stringMatching(/RSU vest/),
      expect.stringMatching(/no schedule is named/),
    ]);

    const withGig = await succeed(
      connection,
      'sync_income_budget',
      {},
      syncSchema,
    );
    expect(withGig.data.changes).toContainEqual({
      category: incomeCategory,
      month: NEXT,
      before: 0,
      after: 700 + 500,
    });

    await succeed(
      connection,
      'set_schedule_category',
      { entries: [{ schedule: 'Side gig', category: null }], dry_run: false },
      changeSchema,
    );
    const cleared = await succeed(
      connection,
      'sync_income_budget',
      {},
      syncSchema,
    );
    expect(cleared.data.changes).toContainEqual({
      category: incomeCategory,
      month: NEXT,
      before: 0,
      after: 700,
    });
  });

  it('changes nothing in an envelope budget', async () => {
    const { data, text } = await succeed(
      connection,
      'sync_income_budget',
      { dry_run: false },
      syncSchema,
    );
    expect(data.budget_type).toBe('envelope');
    expect(data.changes).toEqual([]);
    expect(text).toMatch(/envelope budget/);
  });
});
