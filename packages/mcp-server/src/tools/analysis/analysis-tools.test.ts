import { z } from 'zod';

import {
  ANALYSIS_TODAY,
  EXPECTED,
  PAST_MONTH,
  PAYDAYS,
  seedAnalysisFixture,
} from '#testing/analysis-fixture';
import type { AnalysisFixture } from '#testing/analysis-fixture';
import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

// End-to-end tests of the analysis tools through a real MCP client, on the
// household built in analysis-fixture.ts. The clock is frozen at 2029-12-20.
let budget: TestBudget;
let fixture: AnalysisFixture;
let connection: Awaited<ReturnType<typeof connectTestClient>>;

beforeAll(async () => {
  budget = await createTestBudget({ today: ANALYSIS_TODAY });
  fixture = await budget.use(seedAnalysisFixture);
  connection = await connectTestClient({ session: budget.session });
});

afterAll(async () => {
  await connection.close();
  await budget.dispose();
});

type Json = Record<string, unknown>;

/** Calls a tool that should succeed and parses the part of the result a test cares about. */
async function succeed<Schema extends z.ZodType>(
  name: string,
  args: Json,
  schema: Schema,
) {
  const { result, text, data } = await connection.call(name, args);
  expect(result.isError, text).not.toBe(true);
  return { text, data: schema.parse(data) };
}

async function fail(name: string, args: Json) {
  const { result, text } = await connection.call(name, args);
  expect(result.isError, text).toBe(true);
  return text;
}

const comparison = z.looseObject({
  previous_total: z.number(),
  change: z.number(),
  percent_change: z.number().nullable(),
  direction: z.string(),
});

// --- spending_summary -------------------------------------------------------

const summarySchema = z.looseObject({
  total: z.number(),
  transaction_count: z.number(),
  previous_period: z
    .object({ start_date: z.string(), end_date: z.string() })
    .nullable(),
  comparison: comparison.nullable(),
  rows: z.array(
    z.looseObject({
      key: z.string(),
      name: z.string(),
      total: z.number(),
      transaction_count: z.number(),
      share: z.number().nullable(),
      comparison: comparison.nullable(),
    }),
  ),
  other: z.looseObject({ name: z.string(), total: z.number() }).nullable(),
});

const november = { start_date: '2029-11-01', end_date: '2029-11-30' };
const paydaysIn = (prefix: string) =>
  PAYDAYS.filter(date => date.startsWith(prefix)).length;

describe('spending_summary', () => {
  it('totals the month by category and compares it with the month before', async () => {
    const { data, text } = await succeed(
      'spending_summary',
      { ...november, compare_to_previous: true },
      summarySchema,
    );

    expect(data.total).toBe(-2117.99);
    expect(data.transaction_count).toBe(5);
    expect(data.previous_period).toEqual({
      start_date: '2029-10-01',
      end_date: '2029-10-31',
    });
    expect(data.comparison).toEqual({
      previous_total: -2142.99,
      change: 25,
      percent_change: -1.2,
      direction: 'lower',
    });
    expect(
      data.rows.map(row => [row.name, row.total, row.comparison?.direction]),
    ).toEqual([
      ['Bills', -1517.99, 'unchanged'],
      ['Food', -500, 'higher'],
      ['General', -50, 'lower'],
      ['Dining', -50, 'unchanged'],
    ]);
    expect(data.rows[1].comparison).toMatchObject({
      previous_total: -470,
      change: -30,
      percent_change: 6.4,
    });
    expect(data.rows[0].share).toBe(0.717);
    expect(text).toMatch(/Food: -500\.00 \(23\.6%\).*6\.4% more spent/);
  });

  it('does not count the transfer between two accounts', async () => {
    // Savings sent 400 to Reserve on 20 November.
    const { data } = await succeed(
      'spending_summary',
      { ...november, kind: 'all' },
      summarySchema,
    );

    expect(data.total).toBe(paydaysIn('2029-11') * 2500 - 2117.99);
    expect(data.rows.map(row => row.name)).not.toContain('Transfer');
  });

  it('leaves out off-budget accounts unless asked', async () => {
    const without = await succeed(
      'spending_summary',
      { ...november, kind: 'all' },
      summarySchema,
    );
    const withTracking = await succeed(
      'spending_summary',
      { ...november, kind: 'all', include_off_budget: true },
      summarySchema,
    );

    // The 250 broker fee is in the off-budget Brokerage account.
    expect(withTracking.data.total - without.data.total).toBeCloseTo(-250, 2);
    expect(
      withTracking.data.rows.find(row => row.name === '(uncategorized)')?.total,
    ).toBe(-250);
  });

  it('totals income, and lists a year by month', async () => {
    const income = await succeed(
      'spending_summary',
      { start_date: '2029-01-01', end_date: '2029-12-31', kind: 'income' },
      summarySchema,
    );
    expect(income.data.total).toBe(PAYDAYS.length * 2500);
    expect(income.data.rows.map(row => row.name)).toEqual(['Income']);

    const byMonth = await succeed(
      'spending_summary',
      { start_date: '2029-01-01', end_date: '2029-12-31', group_by: 'month' },
      summarySchema,
    );
    expect(byMonth.data.rows).toHaveLength(12);
    expect(byMonth.data.rows[0]).toMatchObject({
      name: '2029-01',
      total: -1975.98,
    });
    expect(byMonth.data.rows[11]).toMatchObject({
      name: '2029-12',
      total: -4469.32,
    });
    expect(byMonth.data.total).toBe(-27273.15);
  });

  it('rolls the smallest rows into Other', async () => {
    const { data, text } = await succeed(
      'spending_summary',
      { ...november, limit: 2 },
      summarySchema,
    );

    expect(data.rows.map(row => row.name)).toEqual(['Bills', 'Food']);
    expect(data.other).toMatchObject({ name: 'Other (2 more)', total: -100 });
    expect(text).toMatch(/Other \(2 more\): -100\.00/);
  });

  it('can be limited to one account', async () => {
    const savings = await succeed(
      'spending_summary',
      { ...november, account_id: fixture.accounts.savings },
      summarySchema,
    );
    expect(savings.data).toMatchObject({ total: 0, rows: [] });

    const checking = await succeed(
      'spending_summary',
      { ...november, account_id: fixture.accounts.checking },
      summarySchema,
    );
    expect(checking.data.total).toBe(-2117.99);
  });

  it('explains what is wrong with a request', async () => {
    expect(
      await fail('spending_summary', {
        start_date: '2029-11-30',
        end_date: '2029-11-01',
      }),
    ).toMatch(/start_date \(2029-11-30\) must not be after end_date/);
    expect(
      await fail('spending_summary', {
        ...november,
        group_by: 'month',
        compare_to_previous: true,
      }),
    ).toMatch(/spending_trends/);
    expect(
      await fail('spending_summary', {
        start_date: '2020-01-01',
        end_date: '2029-12-31',
        group_by: 'month',
      }),
    ).toMatch(/at most 60 months/);
    expect(
      await fail('spending_summary', { ...november, account_id: 'nope' }),
    ).toMatch(/unknown account_id "nope"/);
    expect(
      await fail('spending_summary', {
        start_date: '2029-02-30',
        end_date: '2029-03-01',
      }),
    ).toMatch(/not a real calendar date/);
  });
});

// --- spending_trends --------------------------------------------------------

const trendSchema = z.looseObject({
  direction: z.string(),
  per_month: z.number(),
  percent_per_month: z.number().nullable(),
  r_squared: z.number(),
});
const seriesShape = {
  series: z.array(z.number()),
  total: z.number(),
  average: z.number(),
  trend: trendSchema,
  month_over_month: comparison.nullable(),
  year_over_year: comparison.nullable(),
};
const trendsSchema = z.looseObject({
  months: z.array(z.string()),
  last_month_is_partial: z.boolean(),
  overall: z.looseObject(seriesShape),
  groups: z.array(z.looseObject({ name: z.string(), ...seriesShape })),
  omitted_group_count: z.number(),
});

describe('spending_trends', () => {
  const window = { months: 9, end_month: '2029-11' };

  it('finds the category that keeps growing and says by how much', async () => {
    const { data, text } = await succeed(
      'spending_trends',
      window,
      trendsSchema,
    );

    expect(data.months).toEqual([
      '2029-03',
      '2029-04',
      '2029-05',
      '2029-06',
      '2029-07',
      '2029-08',
      '2029-09',
      '2029-10',
      '2029-11',
    ]);
    expect(data.groups.map(group => group.name)).toEqual([
      'Food',
      'General',
      'Bills',
      'Dining',
    ]);
    const food = data.groups[0];
    expect(food.series).toEqual([
      -260, -290, -320, -350, -380, -410, -440, -470, -500,
    ]);
    expect(food.trend).toEqual({
      direction: 'up',
      per_month: -30,
      percent_per_month: 7.9,
      r_squared: 1,
    });
    expect(food.month_over_month).toMatchObject({
      previous_total: -470,
      percent_change: 6.4,
    });
    // A year earlier the only grocery run was 400.
    expect(food.year_over_year).toEqual({
      previous_total: -400,
      change: -100,
      percent_change: 25,
      direction: 'higher',
    });
    expect(text).toMatch(/Food: average -380\.00\/month, trend up/);
  });

  it('finds what is shrinking and what is steady', async () => {
    const { data } = await succeed('spending_trends', window, trendsSchema);
    const byName = Object.fromEntries(data.groups.map(g => [g.name, g.trend]));

    expect(byName.General).toMatchObject({
      direction: 'down',
      per_month: 14.88,
    });
    expect(byName.Dining).toMatchObject({ direction: 'flat', per_month: 0 });
    expect(byName.Bills.direction).toBe('flat');
  });

  it('adds up everything for the overall series', async () => {
    const { data } = await succeed('spending_trends', window, trendsSchema);

    expect(data.overall.series[0]).toBe(-2005.98);
    expect(data.overall.series[8]).toBe(-2117.99);
    expect(data.overall.trend.direction).toBe('flat');
  });

  it('looks at the last twelve complete months by default', async () => {
    const { data } = await succeed('spending_trends', {}, trendsSchema);

    expect(data.months).toHaveLength(12);
    expect(data.months[0]).toBe('2028-12');
    expect(data.months[11]).toBe('2029-11');
    expect(data.last_month_is_partial).toBe(false);
  });

  it('marks the current month as partial when asked for it', async () => {
    const { data, text } = await succeed(
      'spending_trends',
      { months: 3, end_month: '2029-12' },
      trendsSchema,
    );

    expect(data.months[2]).toBe('2029-12');
    expect(data.last_month_is_partial).toBe(true);
    expect(text).toMatch(/last month still in progress/);
  });

  it('can be narrowed to one category, by name in any case', async () => {
    const { data } = await succeed(
      'spending_trends',
      { ...window, category: 'food' },
      trendsSchema,
    );

    expect(data.groups.map(group => group.name)).toEqual(['Food']);
    expect(data.overall.total).toBe(data.groups[0].total);
  });

  it('can group by payee and cut the list', async () => {
    const { data } = await succeed(
      'spending_trends',
      { ...window, group_by: 'payee', limit: 2 },
      trendsSchema,
    );

    expect(data.groups).toHaveLength(2);
    expect(data.groups[0].name).toBe('Costco');
    expect(data.omitted_group_count).toBeGreaterThan(0);
  });

  it('can trend income instead', async () => {
    const { data } = await succeed(
      'spending_trends',
      { kind: 'income' },
      trendsSchema,
    );
    const paid = PAYDAYS.filter(date => date <= '2029-11-30').length;

    expect(data.overall.total).toBe(paid * 2500);
  });

  it('explains what is wrong with a request', async () => {
    expect(await fail('spending_trends', { end_month: '2030-01' })).toMatch(
      /end_month 2030-01 is in the future/,
    );
    expect(await fail('spending_trends', { category: 'Nonexistent' })).toMatch(
      /unknown category "Nonexistent"/,
    );
    expect(await fail('spending_trends', { months: 1 })).toMatch(/months/);
    expect(await fail('spending_trends', { end_month: '2029-13' })).toMatch(
      /real month/,
    );
  });
});

// --- find_outliers ----------------------------------------------------------

const brief = z.looseObject({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  payee: z.string().nullable(),
});
const outliersSchema = z.looseObject({
  start_date: z.string(),
  end_date: z.string(),
  history_start: z.string(),
  checked_count: z.number(),
  total_found: z.number(),
  counts: z.object({
    unusual_amount: z.number(),
    new_payee: z.number(),
    possible_duplicate: z.number(),
  }),
  outliers: z.array(
    z.looseObject({
      type: z.string(),
      transaction: brief,
      reason: z.string(),
      related_transaction: brief.nullable(),
      days_apart: z.number().nullable(),
      baseline: z.string().nullable(),
      baseline_size: z.number().nullable(),
      typical_amount: z.number().nullable(),
      times_typical: z.number().nullable(),
    }),
  ),
  notes: z.array(z.string()),
});

describe('find_outliers', () => {
  it('finds the weird charges this month, largest first', async () => {
    const { data, text } = await succeed('find_outliers', {}, outliersSchema);

    expect(data).toMatchObject({
      start_date: '2029-12-01',
      end_date: '2029-12-20',
      history_start: '2028-12-01',
      checked_count: 10,
      total_found: 3,
      counts: { unusual_amount: 1, new_payee: 1, possible_duplicate: 1 },
      notes: [],
    });
    expect(
      data.outliers.map(o => [
        o.type,
        o.transaction.payee,
        o.transaction.amount,
      ]),
    ).toEqual([
      ['new_payee', 'Jewelry Boutique', -1800],
      ['unusual_amount', 'Hardware Store', -400],
      ['possible_duplicate', 'Amazon', -63.17],
    ]);
    expect(text).toMatch(/3 finding\(s\) among 10 purchase\(s\)/);
  });

  it('explains an unusual amount with the numbers behind it', async () => {
    const { data } = await succeed('find_outliers', {}, outliersSchema);
    const hardware = data.outliers.find(o => o.type === 'unusual_amount');

    expect(hardware).toMatchObject({
      baseline: 'payee',
      baseline_size: 7,
      typical_amount: -40,
      times_typical: 10,
      reason:
        'Hardware Store 400.00 is 10.0x the usual 40.00 for this payee (7 earlier purchases)',
    });
  });

  it('points a possible duplicate at the charge it repeats', async () => {
    const { data } = await succeed('find_outliers', {}, outliersSchema);
    const duplicate = data.outliers.find(o => o.type === 'possible_duplicate');

    expect(duplicate).toMatchObject({
      days_apart: 1,
      transaction: { date: '2029-12-04' },
      related_transaction: { date: '2029-12-03', amount: -63.17 },
    });
    expect(duplicate?.transaction.id).not.toBe(
      duplicate?.related_transaction?.id,
    );
  });

  it('finds nothing wrong in a quiet month', async () => {
    const { data, text } = await succeed(
      'find_outliers',
      { start_date: '2029-11-01', end_date: '2029-11-30' },
      outliersSchema,
    );

    expect(data).toMatchObject({
      total_found: 0,
      outliers: [],
      checked_count: 5,
    });
    expect(text).toMatch(/Nothing unusual among 5 purchase\(s\)/);
  });

  it('counts tracking accounts only when asked', async () => {
    const { data } = await succeed(
      'find_outliers',
      {
        start_date: '2029-11-01',
        end_date: '2029-11-30',
        include_off_budget: true,
      },
      outliersSchema,
    );
    // The broker fee in the Brokerage account.
    expect(data.checked_count).toBe(6);
  });

  it('can be limited to the biggest findings, or the biggest amounts', async () => {
    const limited = await succeed(
      'find_outliers',
      { limit: 1 },
      outliersSchema,
    );
    expect(limited.data.outliers).toHaveLength(1);
    expect(limited.data.total_found).toBe(3);
    expect(limited.text).toMatch(/showing the largest 1/);

    const big = await succeed(
      'find_outliers',
      { min_amount: 500 },
      outliersSchema,
    );
    expect(big.data.outliers.map(o => o.transaction.payee)).toEqual([
      'Jewelry Boutique',
    ]);
  });

  it('says when a check could not run', async () => {
    const { data } = await succeed(
      'find_outliers',
      { start_date: '2019-02-10', end_date: '2019-02-20' },
      outliersSchema,
    );
    expect(data.notes[0]).toMatch(/Skipped the new-payee check/);
  });

  it('explains what is wrong with a request', async () => {
    expect(
      await fail('find_outliers', {
        start_date: '2029-12-10',
        end_date: '2029-12-01',
      }),
    ).toMatch(/must not be after end_date/);
    expect(await fail('find_outliers', { account_id: 'nope' })).toMatch(
      /unknown account_id/,
    );
  });
});

// --- detect_recurring -------------------------------------------------------

const recurringSchema = z.looseObject({
  as_of: z.string(),
  lookback_start: z.string(),
  total_found: z.number(),
  active_count: z.number(),
  stopped_count: z.number(),
  price_change_count: z.number(),
  monthly_spending: z.number(),
  monthly_income: z.number(),
  charges: z.array(
    z.looseObject({
      payee: z.string(),
      direction: z.string(),
      cadence: z.string(),
      typical_amount: z.number(),
      amount_variability: z.string(),
      status: z.string(),
      next_expected_date: z.string(),
      price_change: z
        .looseObject({
          from: z.number(),
          to: z.number(),
          percent_change: z.number(),
          changed_on: z.string(),
        })
        .nullable(),
      estimated_yearly_amount: z.number(),
      schedule: z.looseObject({ name: z.string().nullable() }).nullable(),
    }),
  ),
  schedules: z.array(z.looseObject({ name: z.string().nullable() })),
});

describe('detect_recurring', () => {
  it('finds the bills, subscriptions and pay in a year of history', async () => {
    const { data, text } = await succeed(
      'detect_recurring',
      {},
      recurringSchema,
    );

    expect(data).toMatchObject({
      as_of: '2029-12-20',
      lookback_start: '2028-06-01',
      total_found: 6,
      active_count: 5,
      stopped_count: 1,
      price_change_count: 1,
      monthly_spending: -1947.99,
      monthly_income: 5435.27,
    });
    expect(
      data.charges.map(c => [c.payee, c.cadence, c.typical_amount, c.status]),
    ).toEqual([
      ['Employer', 'biweekly', 2500, 'active'],
      ['Landlord', 'monthly', -1500, 'active'],
      ['Costco', 'monthly', -380, 'active'],
      ['Corner Cafe', 'monthly', -50, 'active'],
      ['Netflix', 'monthly', -17.99, 'active'],
      ['Hulu', 'monthly', -9.99, 'stopped'],
    ]);
    expect(text).toMatch(/6 recurring charge\(s\) since 2028-06-01/);
  });

  it('flags the price rise and the cancelled subscription', async () => {
    const { data } = await succeed('detect_recurring', {}, recurringSchema);
    const byName = Object.fromEntries(data.charges.map(c => [c.payee, c]));

    expect(byName.Netflix.price_change).toEqual({
      from: -15.99,
      to: -17.99,
      percent_change: 12.5,
      changed_on: '2029-07-12',
    });
    expect(byName.Netflix.estimated_yearly_amount).toBe(-215.88);
    expect(byName.Hulu).toMatchObject({
      status: 'stopped',
      next_expected_date: '2029-07-05',
    });
    expect(byName.Landlord.price_change).toBeNull();
  });

  it('marks groceries that grow every month as variable, not fixed', async () => {
    const { data } = await succeed('detect_recurring', {}, recurringSchema);
    const costco = data.charges.find(c => c.payee === 'Costco');

    expect(costco?.amount_variability).toBe('variable');
    expect(
      data.charges.find(c => c.payee === 'Landlord')?.amount_variability,
    ).toBe('fixed');
  });

  it('shows which charges an Actual schedule already covers', async () => {
    const { data } = await succeed('detect_recurring', {}, recurringSchema);

    expect(data.charges.find(c => c.payee === 'Landlord')?.schedule?.name).toBe(
      'Rent',
    );
    expect(data.charges.find(c => c.payee === 'Netflix')?.schedule).toBeNull();
    expect(data.schedules.map(s => s.name)).toEqual(['Rent', 'Gym']);
  });

  it('can leave stopped charges out of the list but still count them', async () => {
    const { data } = await succeed(
      'detect_recurring',
      { include_stopped: false },
      recurringSchema,
    );

    expect(data.charges.map(c => c.payee)).not.toContain('Hulu');
    expect(data.stopped_count).toBe(1);
  });

  it('looks only as far back as asked', async () => {
    const { data } = await succeed(
      'detect_recurring',
      { lookback_months: 3 },
      recurringSchema,
    );

    // Since September the price has not moved and Hulu has no charges at all.
    // The gadget shop's four shrinking payments (80, 65, 50, 35 on the 10th)
    // are steady enough to count as a variable monthly charge now; over the
    // whole year they swing too much to.
    expect(data.lookback_start).toBe('2029-09-01');
    expect(data.total_found).toBe(6);
    expect(data.price_change_count).toBe(0);
    expect(data.charges.map(c => c.payee)).toEqual(
      expect.arrayContaining(['Gadget Shop']),
    );
    expect(data.charges.map(c => c.payee)).not.toContain('Hulu');
  });

  it('can demand more occurrences, or fewer results', async () => {
    const strict = await succeed(
      'detect_recurring',
      { lookback_months: 3, min_occurrences: 5 },
      recurringSchema,
    );
    expect(strict.data.charges.map(c => c.payee)).toEqual(['Employer']);

    const limited = await succeed(
      'detect_recurring',
      { limit: 2 },
      recurringSchema,
    );
    expect(limited.data.charges).toHaveLength(2);
    expect(limited.data.total_found).toBe(6);
  });

  it('can be limited to one account', async () => {
    const { data } = await succeed(
      'detect_recurring',
      { account_id: fixture.accounts.savings },
      recurringSchema,
    );
    expect(data.total_found).toBe(0);
  });
});

// --- cash_flow_projection ---------------------------------------------------

const accountsSchema = z.looseObject({
  accounts: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      balance: z.number(),
      off_budget: z.boolean(),
    }),
  ),
});
const projectionSchema = z.looseObject({
  as_of: z.string(),
  end_month: z.string(),
  starting_balance: z.number(),
  months: z.array(
    z.looseObject({
      month: z.string(),
      days: z.number(),
      scheduled_in: z.number(),
      scheduled_out: z.number(),
      baseline_in: z.number(),
      baseline_out: z.number(),
      net: z.number(),
      ending_balance: z.number(),
      accounts: z.array(
        z.looseObject({ name: z.string(), ending_balance: z.number() }),
      ),
    }),
  ),
  lowest_month_end: z.looseObject({ month: z.string(), balance: z.number() }),
  first_negative_month: z.string().nullable(),
  accounts: z.array(
    z.looseObject({
      name: z.string(),
      starting_balance: z.number(),
      ending_balance: z.number(),
    }),
  ),
  baseline: z.looseObject({
    months_averaged: z.number(),
    monthly_in: z.number(),
    monthly_out: z.number(),
    top_spending: z.array(
      z.looseObject({ category: z.string(), monthly_average: z.number() }),
    ),
  }),
  scheduled_events: z.array(
    z.looseObject({
      date: z.string(),
      name: z.string().nullable(),
      account: z.string().nullable(),
      amount: z.number(),
    }),
  ),
  scheduled_event_count: z.number(),
  notes: z.array(z.string()),
});

// What the last three complete months (September to November) contain outside
// the Rent schedule's payee, worked out from the fixture's own tables:
//   Netflix 3 x 17.99, Costco 440 + 470 + 500, Corner Cafe 3 x 50,
//   Gadget Shop 80 + 65 + 50, Hardware 43 (Sep) + 40 (Oct).
// Landlord is left out because a schedule pays it; the transfer is not money
// spent; the broker fee is off budget.
const AVERAGED_OUT = 53.97 + 1410 + 150 + 195 + 83;

describe('cash_flow_projection', () => {
  async function startingBalance(
    include: (account: { off_budget: boolean; name: string }) => boolean,
  ) {
    const { data } = await succeed('list_accounts', {}, accountsSchema);
    return data.accounts
      .filter(include)
      .reduce((sum, account) => sum + account.balance, 0);
  }

  it('projects the rest of December and three more months for every on-budget account', async () => {
    const { data, text } = await succeed(
      'cash_flow_projection',
      {},
      projectionSchema,
    );
    const start = await startingBalance(account => !account.off_budget);

    expect(data.as_of).toBe('2029-12-20');
    expect(data.end_month).toBe('2030-03');
    expect(data.starting_balance).toBeCloseTo(start, 2);
    expect(data.months.map(m => [m.month, m.days])).toEqual([
      ['2029-12', 11],
      ['2030-01', 31],
      ['2030-02', 28],
      ['2030-03', 31],
    ]);
    expect(data.accounts.map(a => a.name)).toEqual([
      'Checking',
      'Savings',
      'Reserve',
    ]);
    expect(text).toMatch(/Cash flow from 2029-12-20 through 2030-03/);
  });

  it('adds the schedules exactly when Actual says they fall', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      {},
      projectionSchema,
    );

    // Rent (1,500) on the 1st and the gym (50) on the 15th, from January.
    expect(data.months.map(m => m.scheduled_out)).toEqual([
      0, -1550, -1550, -1550,
    ]);
    expect(data.scheduled_event_count).toBe(6);
    expect(data.scheduled_events.slice(0, 2)).toEqual([
      {
        date: '2030-01-01',
        name: 'Rent',
        account: 'Checking',
        amount: -1500,
        overdue: false,
      },
      {
        date: '2030-01-15',
        name: 'Gym',
        account: 'Checking',
        amount: -50,
        overdue: false,
      },
    ]);
  });

  it('averages everything else over the last three complete months, once', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      {},
      projectionSchema,
    );
    const paid = PAYDAYS.filter(
      d => d >= '2029-09-01' && d <= '2029-11-30',
    ).length;

    expect(data.baseline.months_averaged).toBe(3);
    expect(data.baseline.monthly_in).toBe(
      Math.round((paid * EXPECTED.paydayAmount * 100) / 3) / 100,
    );
    expect(data.baseline.monthly_out).toBe(
      -Math.round((AVERAGED_OUT * 100) / 3) / 100,
    );
    expect(data.baseline.top_spending).toEqual([
      { category: 'Food', monthly_average: -470 },
      { category: 'General', monthly_average: -92.67 },
      { category: 'Dining', monthly_average: -50 },
      { category: 'Bills', monthly_average: -17.99 },
    ]);
    // January is a whole month of the average.
    expect(data.months[1].baseline_out).toBe(data.baseline.monthly_out);
  });

  it('keeps the books balanced from month to month', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      {},
      projectionSchema,
    );

    let balance = data.starting_balance;
    for (const month of data.months) {
      balance += month.net;
      expect(month.ending_balance, month.month).toBeCloseTo(balance, 2);
      expect(
        month.accounts.reduce(
          (sum, account) => sum + account.ending_balance,
          0,
        ),
      ).toBeCloseTo(month.ending_balance, 2);
    }
    expect(
      data.accounts.reduce((sum, a) => sum + a.ending_balance, 0),
    ).toBeCloseTo(balance, 2);
  });

  it('can stop at a named month', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      { through_month: '2030-01', months: 12 },
      projectionSchema,
    );
    expect(data.months.map(m => m.month)).toEqual(['2029-12', '2030-01']);
  });

  it('can project the schedules alone', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      { include_baseline: false },
      projectionSchema,
    );

    expect(
      data.months.every(m => m.baseline_in === 0 && m.baseline_out === 0),
    ).toBe(true);
    expect(data.baseline).toMatchObject({
      months_averaged: 0,
      monthly_in: 0,
      monthly_out: 0,
    });
    expect(data.months[3].ending_balance).toBeCloseTo(
      data.starting_balance - 3 * 1550,
      2,
    );
  });

  it('can leave a category out of the average', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      { exclude_categories: ['food'] },
      projectionSchema,
    );

    expect(data.baseline.monthly_out).toBe(
      -Math.round(((AVERAGED_OUT - 1410) * 100) / 3) / 100,
    );
    expect(data.baseline.top_spending.map(s => s.category)).not.toContain(
      'Food',
    );
  });

  it('can include the tracking accounts', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      { include_off_budget: true },
      projectionSchema,
    );

    expect(data.accounts.map(a => a.name)).toContain('Brokerage');
    // The 250 broker fee now counts towards the average.
    expect(data.baseline.monthly_out).toBe(
      -Math.round(((AVERAGED_OUT + 250) * 100) / 3) / 100,
    );
  });

  it('can follow one account', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      { account_id: fixture.accounts.checking },
      projectionSchema,
    );
    const checking = await startingBalance(
      account => account.name === 'Checking',
    );

    expect(data.accounts.map(a => a.name)).toEqual(['Checking']);
    expect(data.starting_balance).toBeCloseTo(checking, 2);
  });

  it('warns about schedules it cannot match to past spending', async () => {
    const { data } = await succeed(
      'cash_flow_projection',
      {},
      projectionSchema,
    );
    expect(data.notes.join(' ')).toMatch(/without a payee/);
  });

  it('explains what is wrong with a request', async () => {
    expect(
      await fail('cash_flow_projection', { through_month: '2029-11' }),
    ).toMatch(/before the current month \(2029-12\)/);
    expect(
      await fail('cash_flow_projection', { through_month: '2032-06' }),
    ).toMatch(/at most 24 months/);
    expect(await fail('cash_flow_projection', { months: 25 })).toMatch(
      /months/,
    );
    expect(await fail('cash_flow_projection', { account_id: 'nope' })).toMatch(
      /unknown or closed account_id "nope"/,
    );
    expect(
      await fail('cash_flow_projection', {
        exclude_categories: ['Nonexistent'],
      }),
    ).toMatch(/unknown category "Nonexistent"/);
  });
});

// --- month_comparison -------------------------------------------------------

const varianceSchema = z.looseObject({
  category: z.string(),
  budgeted: z.number(),
  spent: z.number(),
  variance: z.number(),
  percent_used: z.number().nullable(),
});
const comparisonResultSchema = z.looseObject({
  month: z.string(),
  in_progress: z.boolean(),
  totals: z.object({
    budgeted: z.number(),
    spent: z.number(),
    variance: z.number(),
  }),
  overspent: z.array(varianceSchema),
  underspent: z.array(varianceSchema),
  overspent_count: z.number(),
  underspent_count: z.number(),
  on_budget_count: z.number(),
});

describe('month_comparison', () => {
  it('shows where a month went over and where it had room', async () => {
    const { data, text } = await succeed(
      'month_comparison',
      { month: PAST_MONTH },
      comparisonResultSchema,
    );

    expect(data).toMatchObject({
      month: PAST_MONTH,
      in_progress: false,
      totals: { budgeted: 2090, spent: -2117.99, variance: -27.99 },
      overspent_count: 3,
      underspent_count: 1,
      on_budget_count: 0,
    });
    expect(
      data.overspent.map(c => [c.category, c.variance, c.percent_used]),
    ).toEqual([
      ['Food', -50, 111.1],
      // Nothing was budgeted for general spending at all.
      ['General', -50, null],
      ['Dining', -10, 125],
    ]);
    expect(data.underspent.map(c => [c.category, c.variance])).toEqual([
      ['Bills', 82.01],
    ]);
    expect(text).toMatch(
      /Food \(Usual Expenses\): budgeted 450\.00, spent -500\.00, over by 50\.00/,
    );
  });

  it('cuts the lists at the limit', async () => {
    const { data } = await succeed(
      'month_comparison',
      { month: PAST_MONTH, limit: 1 },
      comparisonResultSchema,
    );

    expect(data.overspent.map(c => c.category)).toEqual(['Food']);
    expect(data.overspent_count).toBe(3);
  });

  it('says which months it has when asked for one it does not', async () => {
    expect(await fail('month_comparison', { month: '2999-01' })).toMatch(
      /No budget exists for month 2999-01\. Budgets exist from 2018-11/,
    );
    expect(await fail('month_comparison', { month: 'March' })).toMatch(
      /YYYY-MM/,
    );
  });
});

describe('with only a few weeks of history', () => {
  // The template's one transaction is on 2019-02-06.
  let early: TestBudget;
  let earlyConnection: Awaited<ReturnType<typeof connectTestClient>>;

  beforeAll(async () => {
    early = await createTestBudget({ today: '2019-02-20' });
    earlyConnection = await connectTestClient({ session: early.session });
  });

  afterAll(async () => {
    await earlyConnection.close();
    await early.dispose();
  });

  it('projects only the schedules, and says why', async () => {
    const { result, data, text } = await earlyConnection.call(
      'cash_flow_projection',
      { months: 2 },
    );
    expect(result.isError, text).not.toBe(true);
    const projection = projectionSchema.parse(data);

    expect(projection.notes.join(' ')).toMatch(/no complete month of history/);
    expect(projection.baseline.months_averaged).toBe(0);
    expect(projection.months.map(m => m.month)).toEqual([
      '2019-02',
      '2019-03',
      '2019-04',
    ]);
    for (const month of projection.months) {
      expect(month.ending_balance).toBeCloseTo(projection.starting_balance, 2);
    }
  });

  it('calls the current month in progress', async () => {
    const { result, data, text } = await earlyConnection.call(
      'month_comparison',
      {},
    );
    expect(result.isError, text).not.toBe(true);

    expect(comparisonResultSchema.parse(data)).toMatchObject({
      month: '2019-02',
      in_progress: true,
      overspent_count: 0,
    });
    expect(text).toMatch(/2019-02 \(in progress\)/);
  });
});
