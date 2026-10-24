import { z } from 'zod';

import { connectTestClient } from '#testing/client';
import { EXPECTED, seedFixture } from '#testing/fixture';
import type { Fixture } from '#testing/fixture';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

// Tests for the tools that list the things a budget is made of: categories,
// payees, budget months, schedules and rules. The budget is seeded once.
let budget: TestBudget;
let fixture: Fixture;
let connection: Awaited<ReturnType<typeof connectTestClient>>;

beforeAll(async () => {
  budget = await createTestBudget();
  fixture = await budget.use(seedFixture);
  connection = await connectTestClient({ session: budget.session });
});

afterAll(async () => {
  await connection.close();
  await budget.dispose();
});

type Json = Record<string, unknown>;
const call = (name: string, args: Json = {}) => connection.call(name, args);

const categoriesSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_income: z.boolean(),
      hidden: z.boolean(),
      categories: z.array(
        z.object({ id: z.string(), name: z.string(), hidden: z.boolean() }),
      ),
    }),
  ),
});
const payeesSchema = z.object({
  payees: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_transfer: z.boolean(),
      transfer_account_id: z.string().nullable(),
    }),
  ),
  total_count: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
});
const monthAmounts = {
  budgeted: z.number().nullable(),
  spent: z.number().nullable(),
  received: z.number().nullable(),
  balance: z.number().nullable(),
};
const budgetMonthSchema = z.object({
  month: z.string(),
  budget_type: z.string(),
  totals: z.record(z.string(), z.number()),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_income: z.boolean(),
      hidden: z.boolean(),
      ...monthAmounts,
      categories: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          hidden: z.boolean(),
          carryover: z.boolean().nullable(),
          ...monthAmounts,
        }),
      ),
    }),
  ),
});
const scheduleSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  next_date: z.string().nullable(),
  completed: z.boolean(),
  posts_transaction: z.boolean(),
  payee: z.string().nullable(),
  account: z.string().nullable(),
  amount: z.number().nullable(),
  amount_upper: z.number().nullable(),
  amount_match: z.string().nullable(),
  recurrence: z.object({
    description: z.string(),
    frequency: z.string(),
    interval: z.number(),
    start: z.string(),
    ends: z.string().nullable(),
  }),
});
const schedulesSchema = z.object({ schedules: z.array(scheduleSchema) });
const rulesSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      stage: z.string(),
      match: z.string(),
      conditions: z.array(
        z.object({
          field: z.string(),
          op: z.string(),
          value: z.unknown(),
          value_text: z.string(),
        }),
      ),
      actions: z.array(
        z.object({
          op: z.string(),
          field: z.string().nullable(),
          value: z.unknown(),
          value_text: z.string(),
        }),
      ),
      summary: z.string(),
    }),
  ),
});

describe('get_categories', () => {
  it('lists visible groups and categories in budget order, with ids', async () => {
    const { result, data, text } = await call('get_categories');

    expect(result.isError).toBeFalsy();
    const { groups } = categoriesSchema.parse(data);
    const names = groups.flatMap(group => group.categories.map(c => c.name));
    expect(names).toEqual(
      expect.arrayContaining(['Food', 'Bills', 'General', 'Extra 1']),
    );

    const food = groups
      .flatMap(group => group.categories)
      .find(category => category.name === 'Food');
    expect(food).toEqual({
      id: fixture.categories.food,
      name: 'Food',
      hidden: false,
    });
    expect(text).toContain(`- Food [id: ${fixture.categories.food}]`);
  });

  it('leaves out hidden categories and hidden groups by default', async () => {
    const { data, text } = await call('get_categories');

    const { groups } = categoriesSchema.parse(data);
    const names = groups.flatMap(group => group.categories.map(c => c.name));
    expect(names).not.toContain('Retired Extra');
    expect(names).not.toContain('Old Hobby');
    expect(groups.map(group => group.name)).not.toContain('Archive');
    expect(text).not.toContain('Old Hobby');
  });

  it('shows them, flagged, when asked', async () => {
    const { data, text } = await call('get_categories', {
      include_hidden: true,
    });

    const { groups } = categoriesSchema.parse(data);
    const archive = groups.find(group => group.name === 'Archive');
    expect(archive).toMatchObject({
      hidden: true,
      categories: [{ name: 'Old Hobby', hidden: true }],
    });
    const extras = groups.find(group => group.name === 'Extras');
    expect(extras?.hidden).toBe(false);
    expect(
      extras?.categories.find(c => c.name === 'Retired Extra')?.hidden,
    ).toBe(true);
    expect(text).toContain('Archive (hidden)');
    expect(text).toContain('Retired Extra (hidden)');
  });

  it('marks income groups', async () => {
    const { data, text } = await call('get_categories');

    const { groups } = categoriesSchema.parse(data);
    expect(groups.some(group => group.is_income)).toBe(true);
    expect(text).toContain('(income)');
  });
});

describe('get_payees', () => {
  it('lists payees alphabetically, ignoring case', async () => {
    const { data } = await call('get_payees');

    const { payees, total_count } = payeesSchema.parse(data);
    const names = payees.map(payee => payee.name);
    expect(names).toEqual(
      [...names].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    );
    expect(names).toEqual(
      expect.arrayContaining(['Costco', 'Netflix', "Trader Joe's", 'Amazon']),
    );
    expect(total_count).toBe(payees.length);
  });

  it('flags the payees that stand for transfers between accounts', async () => {
    const { data, text } = await call('get_payees', { search: 'brokerage' });

    const { payees } = payeesSchema.parse(data);
    expect(payees).toEqual([
      {
        id: expect.any(String),
        name: 'Brokerage',
        is_transfer: true,
        transfer_account_id: fixture.accounts.brokerage,
      },
    ]);
    expect(text).toContain('Brokerage (transfer)');
  });

  it('searches by part of the name, ignoring case', async () => {
    const { data, text } = await call('get_payees', { search: 'COST' });

    const { payees } = payeesSchema.parse(data);
    expect(payees.map(payee => payee.name)).toEqual(['Costco']);
    expect(text).toContain(`Costco [id: ${fixture.payees.costco}]`);
  });

  it("finds names with an apostrophe, like Trader Joe's", async () => {
    const { data } = await call('get_payees', { search: "joe's" });

    expect(payeesSchema.parse(data).payees.map(p => p.name)).toEqual([
      "Trader Joe's",
    ]);
  });

  it('pages through the list without losing or repeating anyone', async () => {
    const all = payeesSchema.parse((await call('get_payees')).data);
    const first = payeesSchema.parse(
      (await call('get_payees', { limit: 3 })).data,
    );
    const second = payeesSchema.parse(
      (await call('get_payees', { limit: 3, offset: 3 })).data,
    );

    expect(first.payees).toHaveLength(3);
    expect(first.has_more).toBe(true);
    expect(first.total_count).toBe(all.total_count);
    expect(second.offset).toBe(3);
    expect([...first.payees, ...second.payees].map(p => p.id)).toEqual(
      all.payees.slice(0, 6).map(p => p.id),
    );
  });

  it('says so, and is not an error, when no payee matches', async () => {
    const { result, data, text } = await call('get_payees', {
      search: 'no such merchant',
    });

    expect(result.isError).toBeFalsy();
    expect(payeesSchema.parse(data)).toEqual({
      payees: [],
      total_count: 0,
      offset: 0,
      has_more: false,
    });
    expect(text).toBe('No payees matched.');
  });

  it.each([{ limit: 0 }, { limit: 501 }, { offset: -1 }])(
    'rejects bad paging %j',
    async args => {
      const { result, text } = await call('get_payees', args);

      expect(result.isError).toBe(true);
      expect(text).toContain('Input validation error');
    },
  );
});

describe('get_budget_months', () => {
  it('lists the months oldest first as YYYY-MM', async () => {
    const { data, text } = await call('get_budget_months');

    const { months } = z.object({ months: z.array(z.string()) }).parse(data);
    expect(months.length).toBeGreaterThan(0);
    for (const month of months) expect(month).toMatch(/^\d{4}-\d{2}$/);
    expect(months).toEqual([...months].sort());
    expect(months).toEqual(expect.arrayContaining(['2026-09', '2026-10']));
    expect(text).toContain(
      `${months.length} month(s), from ${months[0]} to ${months[months.length - 1]}.`,
    );
  });
});

describe('get_budget_month', () => {
  const september = async () => {
    const { result, data, text } = await call('get_budget_month', {
      month: '2026-09',
    });
    expect(result.isError, text).toBeFalsy();
    return { budgetMonth: budgetMonthSchema.parse(data), text };
  };
  const category = (
    month: z.output<typeof budgetMonthSchema>,
    name: string,
  ) => {
    const found = month.groups
      .flatMap(group => group.categories)
      .find(candidate => candidate.name === name);
    if (!found) throw new Error(`no category ${name} in ${month.month}`);
    return found;
  };

  it('reports what was budgeted, spent and left, in major units', async () => {
    const { budgetMonth } = await september();

    expect(budgetMonth.month).toBe('2026-09');
    expect(budgetMonth.budget_type).toBe('envelope');
    expect(category(budgetMonth, 'Food')).toMatchObject({
      budgeted: EXPECTED.septFoodBudgeted,
      spent: EXPECTED.septFoodSpent,
      balance: EXPECTED.septFoodBalance,
    });
    // Netflix 15.99 against a 20.00 budget.
    expect(category(budgetMonth, 'Bills')).toMatchObject({
      budgeted: 20,
      spent: -15.99,
      balance: 4.01,
    });
  });

  it('adds up the month', async () => {
    const { budgetMonth } = await september();

    expect(budgetMonth.totals.total_budgeted).toBe(420);
    // Costco 127.75 + Netflix 15.99.
    expect(budgetMonth.totals.total_spent).toBe(-143.74);
  });

  it('puts the same figures in the text for clients that only show text', async () => {
    const { text } = await september();

    expect(text).toContain('Budget for 2026-09 (envelope)');
    expect(text).toContain(
      'Food: budgeted 400.00, spent -127.75, balance 272.25',
    );
  });

  it('includes hidden categories, flagged', async () => {
    const { budgetMonth } = await september();

    expect(category(budgetMonth, 'Retired Extra').hidden).toBe(true);
    expect(budgetMonth.groups.find(g => g.name === 'Archive')?.hidden).toBe(
      true,
    );
  });

  it('returns a month with no budget as zeros, not as a failure', async () => {
    const { result, data } = await call('get_budget_month', {
      month: '2026-10',
    });

    expect(result.isError).toBeFalsy();
    const october = budgetMonthSchema.parse(data);
    expect(category(october, 'Food').budgeted).toBe(0);
    // October's Costco purchases are still counted as spending.
    expect(category(october, 'General').spent).toBe(-150);
  });

  it('names the months that do exist when asked for one that does not', async () => {
    const { result, text } = await call('get_budget_month', {
      month: '2099-01',
    });

    expect(result.isError).toBe(true);
    expect(text).toMatch(
      /No budget exists for month 2099-01\. Budgets exist from \d{4}-\d{2} to \d{4}-\d{2}\./,
    );
  });

  it.each(['2026-9', '2026-13', '2026-09-01', 'September', ''])(
    'rejects the malformed month "%s"',
    async month => {
      const { result, text } = await call('get_budget_month', { month });

      expect(result.isError).toBe(true);
      expect(text).toContain('Input validation error');
    },
  );
});

describe('get_schedules', () => {
  const schedules = async (args: Json = {}) =>
    schedulesSchema.parse((await call('get_schedules', args)).data).schedules;

  it('lists active schedules soonest first', async () => {
    const found = await schedules();

    expect(found.map(schedule => schedule.name)).toEqual([
      'Netflix',
      'Gym',
      'Tax bill',
    ]);
    expect(found.map(schedule => schedule.next_date)).toEqual([
      '2030-01-15',
      '2030-02-04',
      '2030-06-01',
    ]);
  });

  it('describes an exact monthly payment', async () => {
    const [netflix] = await schedules();

    expect(netflix).toMatchObject({
      payee: 'Netflix',
      account: 'Checking',
      amount: -15.99,
      amount_upper: null,
      amount_match: 'exact',
      posts_transaction: false,
      completed: false,
      recurrence: {
        description: 'every month, starting 2030-01-15',
        frequency: 'monthly',
        interval: 1,
        start: '2030-01-15',
        ends: null,
      },
    });
  });

  it('describes a payment that falls in a range', async () => {
    const gym = (await schedules()).find(s => s.name === 'Gym');

    expect(gym).toMatchObject({
      amount: -60,
      amount_upper: -40,
      amount_match: 'between',
      posts_transaction: true,
      recurrence: {
        description: 'every 2 weeks, starting 2030-02-04',
        frequency: 'weekly',
        interval: 2,
      },
    });
  });

  it('describes an approximate one-off payment', async () => {
    const tax = (await schedules()).find(s => s.name === 'Tax bill');

    expect(tax).toMatchObject({
      amount: -500,
      amount_match: 'approximate',
      recurrence: {
        description: 'once, on 2030-06-01',
        frequency: 'once',
        start: '2030-06-01',
      },
    });
  });

  it('hides finished schedules unless asked', async () => {
    expect((await schedules()).map(s => s.name)).not.toContain('Old gym');

    const all = await schedules({ include_completed: true });
    expect(all.find(s => s.name === 'Old gym')).toMatchObject({
      completed: true,
      recurrence: { frequency: 'once', start: '2030-03-01' },
    });
  });

  it('shows amounts, dates and recurrence in the text', async () => {
    const { text } = await call('get_schedules');

    expect(text).toContain(
      '2030-01-15 | Netflix | -15.99 | Netflix | Checking | every month, starting 2030-01-15',
    );
    expect(text).toContain('between -60.00 and -40.00');
    expect(text).toContain('~-500.00');
  });
});

describe('get_rules', () => {
  const rules = async (args: Json = {}) =>
    rulesSchema.parse((await call('get_rules', args)).data).rules;

  it('lists the rules without the hidden ones that schedules create', async () => {
    const found = await rules();

    expect(found.map(rule => rule.id).sort()).toEqual(
      [
        fixture.rules.costcoRule.id,
        fixture.rules.bigPurchaseRule.id,
        fixture.rules.midRangeRule.id,
      ].sort(),
    );
  });

  it('lists the rules schedules keep behind the scenes only when asked', async () => {
    const withSchedules = await rules({ include_schedule_rules: true });

    expect(withSchedules).toHaveLength(7);
    const netflix = withSchedules.find(rule =>
      rule.actions.some(action => action.op === 'link-schedule'),
    );
    expect(netflix).toBeDefined();
    const linked = withSchedules.filter(rule =>
      rule.actions.some(action => action.op === 'link-schedule'),
    );
    expect(linked.map(rule => rule.actions[0].value_text).sort()).toEqual([
      'Gym',
      'Netflix',
      'Old gym',
      'Tax bill',
    ]);
  });

  it('replaces ids with names in a payee-to-category rule', async () => {
    const costco = (await rules()).find(
      rule => rule.id === fixture.rules.costcoRule.id,
    );

    expect(costco).toMatchObject({
      stage: 'pre',
      match: 'all',
      conditions: [{ field: 'payee', op: 'is', value_text: 'Costco' }],
      actions: [{ op: 'set', field: 'category', value_text: 'Food' }],
      summary: '[pre] If payee is Costco, then set category to Food',
    });
  });

  it('shows amounts in major units, not cents', async () => {
    const big = (await rules()).find(
      rule => rule.id === fixture.rules.bigPurchaseRule.id,
    );

    expect(big?.stage).toBe('default');
    expect(big?.conditions).toEqual([
      { field: 'amount', op: 'lt', value: -100, value_text: '-100.00' },
    ]);
    expect(big?.summary).toBe(
      'If amount < -100.00, then add " [large]" to the end of the notes',
    );
  });

  it('handles "any of" rules, amount ranges and the post stage', async () => {
    const mid = (await rules()).find(
      rule => rule.id === fixture.rules.midRangeRule.id,
    );

    expect(mid).toMatchObject({
      stage: 'post',
      match: 'any',
      conditions: [
        {
          field: 'amount',
          op: 'isbetween',
          value: { num1: -50, num2: -10 },
          value_text: '-50.00 and -10.00',
        },
        { field: 'imported_payee', op: 'contains', value_text: 'AMZN' },
      ],
    });
    expect(mid?.summary).toBe(
      '[post] If amount is between -50.00 and -10.00 or imported payee contains AMZN, then set category to General',
    );
  });

  it('shows only the rules that mention a payee when given one', async () => {
    const found = await rules({ payee_id: fixture.payees.costco });

    expect(found.map(rule => rule.id)).toEqual([fixture.rules.costcoRule.id]);
  });

  it('returns nothing, not an error, for a payee no rule mentions', async () => {
    const { result, data, text } = await call('get_rules', {
      payee_id: fixture.payees.netflix,
    });

    expect(result.isError).toBeFalsy();
    expect(rulesSchema.parse(data).rules).toEqual([]);
    expect(text).toBe('No rules.');
  });

  it('puts the summary and id in the text', async () => {
    const { text } = await call('get_rules');

    expect(text).toContain(
      `[pre] If payee is Costco, then set category to Food [id: ${fixture.rules.costcoRule.id}]`,
    );
  });

  it('explains how to find a payee id when the one given is unknown', async () => {
    const { result, text } = await call('get_rules', {
      payee_id: 'not-a-payee',
    });

    expect(result.isError).toBe(true);
    expect(text).toContain('unknown payee_id "not-a-payee"');
    expect(text).toContain('get_payees');
  });
});
