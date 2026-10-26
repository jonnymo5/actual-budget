import { z } from 'zod';

import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import { fail, succeed } from '#testing/tools';

// Every test gets a budget of its own, because they all change it. The three
// months used are the last three the template budget has.
let budget: TestBudget;
let connection: Awaited<ReturnType<typeof connectTestClient>>;
let months: [string, string, string];
let incomeCategory: string;

beforeEach(async () => {
  budget = await createTestBudget();
  const found = await budget.use(async ({ api }) => {
    const all = await api.getBudgetMonths();
    const income = (await api.getCategoryGroups()).find(g => g.is_income);
    const category = income?.categories?.[0];
    if (all.length < 3 || !category) throw new Error('template has no months');
    return { last: all.slice(-3), incomeCategory: category.name };
  });
  const [first, second, third] = found.last;
  months = [first, second, third];
  incomeCategory = found.incomeCategory;
  connection = await connectTestClient({ session: budget.session });
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

const setSchema = z.object({
  budget_type: z.enum(['envelope', 'tracking']),
  changed_count: z.number(),
  unchanged_count: z.number(),
  skipped_count: z.number(),
  applied_count: z.number(),
  changes: z.array(
    z.object({
      month: z.string(),
      category: z.string(),
      is_income: z.boolean(),
      from: z.number(),
      to: z.number(),
    }),
  ),
  skipped: z.array(
    z.object({ month: z.string(), category: z.string(), reason: z.string() }),
  ),
  totals: z.array(
    z.object({
      month: z.string(),
      expense_before: z.number(),
      expense_after: z.number(),
      income_before: z.number().nullable(),
      income_after: z.number().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});

const monthSchema = z.object({
  budget_type: z.enum(['envelope', 'tracking']),
  groups: z.array(
    z.object({
      categories: z.array(
        z.object({ name: z.string(), budgeted: z.number().nullable() }),
      ),
    }),
  ),
});

function set(args: Record<string, unknown>) {
  return succeed(connection, 'set_budget_amounts', args, setSchema);
}

/** What get_budget_month reports as budgeted for a category. */
async function budgeted(month: string, category: string) {
  const { data } = await succeed(
    connection,
    'get_budget_month',
    { month },
    monthSchema,
  );
  const found = data.groups
    .flatMap(group => group.categories)
    .find(c => c.name === category);
  expect(found, `${category} in ${month}`).toBeDefined();
  return found?.budgeted ?? null;
}

async function useTrackingBudget() {
  await budget.use(async ctx => {
    await ctx.api.setPreference('budgetType', 'tracking');
    await ctx.api.loadBudget(ctx.budget.id);
  });
}

describe('set_budget_amounts', () => {
  it('previews by default and changes nothing', async () => {
    const [month] = months;
    const { data, text } = await set({
      entries: [{ category: 'Food', months: [month], amount: 400 }],
    });

    expect(data).toMatchObject({
      dry_run: true,
      budget_type: 'envelope',
      changed_count: 1,
      applied_count: 0,
    });
    expect(data.changes).toEqual([
      { month, category: 'Food', is_income: false, from: 0, to: 400 },
    ]);
    expect(text).toMatch(/Would set 1 budget amount/);
    expect(await budgeted(month, 'Food')).toBe(0);
  });

  it('sets one amount for several months and several categories', async () => {
    const [first, second] = months;
    const { data } = await set({
      entries: [
        { category: 'Food', months: [first, second], amount: 2700.5 },
        { category: 'bills', months: [second], amount: 90.47 },
      ],
      dry_run: false,
    });

    expect(data).toMatchObject({ changed_count: 3, applied_count: 3 });
    expect(await budgeted(first, 'Food')).toBe(2700.5);
    expect(await budgeted(second, 'Food')).toBe(2700.5);
    expect(await budgeted(second, 'Bills')).toBe(90.47);
    expect(await budgeted(first, 'Bills')).toBe(0);
  });

  it("reports each month's budgeted total before and after", async () => {
    const [first, second] = months;
    await set({
      entries: [{ category: 'Food', months: [first], amount: 100 }],
      dry_run: false,
    });

    const { data } = await set({
      entries: [
        { category: 'Food', months: [first, second], amount: 250 },
        { category: 'Bills', months: [first], amount: 50 },
      ],
    });

    const byMonth = new Map(data.totals.map(t => [t.month, t]));
    expect(byMonth.get(first)).toMatchObject({
      expense_before: 100,
      expense_after: 300,
    });
    expect(byMonth.get(second)).toMatchObject({
      expense_before: 0,
      expense_after: 250,
    });
  });

  it('counts an amount that is already right as unchanged, and zero clears one', async () => {
    const [month] = months;
    await set({
      entries: [{ category: 'Food', months: [month], amount: 400 }],
      dry_run: false,
    });

    const same = await set({
      entries: [{ category: 'Food', months: [month], amount: 400 }],
      dry_run: false,
    });
    expect(same.data).toMatchObject({
      changed_count: 0,
      unchanged_count: 1,
      applied_count: 0,
    });

    await set({
      entries: [{ category: 'Food', months: [month], amount: 0 }],
      dry_run: false,
    });
    expect(await budgeted(month, 'Food')).toBe(0);
  });

  it('only touches the categories it is given', async () => {
    const [month] = months;
    await set({
      entries: [{ category: 'Food', months: [month], amount: 400 }],
      dry_run: false,
    });
    await set({
      entries: [{ category: 'Bills', months: [month], amount: 60 }],
      dry_run: false,
    });
    expect(await budgeted(month, 'Food')).toBe(400);
  });

  describe('in an envelope budget', () => {
    it('skips income categories, says why, and still sets the rest', async () => {
      const [month] = months;
      const { data, text } = await set({
        entries: [
          { category: incomeCategory, months: [month], amount: 5000 },
          { category: 'Food', months: [month], amount: 400 },
        ],
        dry_run: false,
      });

      expect(data).toMatchObject({ changed_count: 1, skipped_count: 1 });
      expect(data.skipped[0]).toMatchObject({
        month,
        category: incomeCategory,
        reason: expect.stringMatching(/only be budgeted in a tracking budget/),
      });
      expect(data.totals[0]).toMatchObject({
        income_before: null,
        income_after: null,
      });
      expect(await budgeted(month, 'Food')).toBe(400);
      expect(text).toMatch(/skipped/);
    });

    it('warns that a tracking budget keeps its own amounts', async () => {
      const [month] = months;
      const { data } = await set({
        entries: [{ category: 'Food', months: [month], amount: 400 }],
      });
      expect(data.warnings.join(' ')).toMatch(/tracking budget keeps its own/);
    });
  });

  describe('in a tracking budget', () => {
    it('budgets income as well as expenses', async () => {
      await useTrackingBudget();
      const [month] = months;

      const preview = await set({
        entries: [
          { category: incomeCategory, months: [month], amount: 15540.7 },
          { category: 'Food', months: [month], amount: 2700 },
        ],
      });
      expect(preview.data).toMatchObject({
        budget_type: 'tracking',
        changed_count: 2,
        skipped_count: 0,
      });
      expect(preview.data.totals[0]).toMatchObject({
        expense_after: 2700,
        income_before: 0,
        income_after: 15540.7,
      });
      expect(preview.data.warnings).toEqual([]);

      await set({
        entries: [
          { category: incomeCategory, months: [month], amount: 15540.7 },
          { category: 'Food', months: [month], amount: 2700 },
        ],
        dry_run: false,
      });
      expect(await budgeted(month, incomeCategory)).toBe(15540.7);
      expect(await budgeted(month, 'Food')).toBe(2700);
    });

    it('can be read back by get_budget_month and month_comparison', async () => {
      // A tracking budget has no To Budget, so Actual leaves those figures out.
      await useTrackingBudget();
      const [month] = months;
      await set({
        entries: [{ category: 'Food', months: [month], amount: 400 }],
        dry_run: false,
      });

      const { data } = await succeed(
        connection,
        'get_budget_month',
        { month },
        z.object({
          budget_type: z.string(),
          totals: z.object({
            total_budgeted: z.number(),
            to_budget: z.number().nullable(),
            income_available: z.number().nullable(),
            from_last_month: z.number().nullable(),
          }),
        }),
      );
      expect(data.budget_type).toBe('tracking');
      expect(data.totals).toMatchObject({
        total_budgeted: 400,
        to_budget: null,
        income_available: null,
        from_last_month: null,
      });

      const comparison = await succeed(
        connection,
        'month_comparison',
        { month },
        z.object({ totals: z.object({ budgeted: z.number() }) }),
      );
      expect(comparison.data.totals.budgeted).toBe(400);
    });

    it('keeps separate amounts from the envelope budget', async () => {
      const [month] = months;
      await set({
        entries: [{ category: 'Food', months: [month], amount: 400 }],
        dry_run: false,
      });
      expect(await budgeted(month, 'Food')).toBe(400);

      await useTrackingBudget();
      // The envelope amount is still stored, but the tracking budget starts empty.
      expect(await budgeted(month, 'Food')).toBe(0);
      await set({
        entries: [{ category: 'Food', months: [month], amount: 900 }],
        dry_run: false,
      });
      expect(await budgeted(month, 'Food')).toBe(900);
    });
  });

  describe('bad requests', () => {
    it('name the categories it knows when one is unknown', async () => {
      const [month] = months;
      expect(
        await fail(connection, 'set_budget_amounts', {
          entries: [{ category: 'Fod', months: [month], amount: 1 }],
        }),
      ).toMatch(/unknown category "Fod"/);
    });

    it('refuse a month that has no budget, and say which exist', async () => {
      expect(
        await fail(connection, 'set_budget_amounts', {
          entries: [{ category: 'Food', months: ['1990-01'], amount: 1 }],
        }),
      ).toMatch(/No budget exists for month 1990-01\. Budgets exist from/);
    });

    it('refuse a negative amount and a malformed month', async () => {
      const [month] = months;
      expect(
        await fail(connection, 'set_budget_amounts', {
          entries: [{ category: 'Food', months: [month], amount: -5 }],
        }),
      ).toMatch(/amount/i);
      expect(
        await fail(connection, 'set_budget_amounts', {
          entries: [{ category: 'Food', months: ['2026-13'], amount: 5 }],
        }),
      ).toMatch(/month|real/i);
    });

    it('refuse the same category and month given twice', async () => {
      const [month] = months;
      expect(
        await fail(connection, 'set_budget_amounts', {
          entries: [
            { category: 'Food', months: [month], amount: 1 },
            { category: 'food', months: [month], amount: 2 },
          ],
        }),
      ).toMatch(/Food is given more than once for/);
    });
  });
});
