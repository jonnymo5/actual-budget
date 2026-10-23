import { z } from 'zod';

import { connectTestClient } from '#testing/client';
import { seedFixture } from '#testing/fixture';
import type { Fixture } from '#testing/fixture';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

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

const resultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
});

async function query(args: Json) {
  const { result, data, text } = await connection.call('run_query', args);
  expect(result.isError, text).toBeFalsy();
  return { ...resultSchema.parse(data), text };
}

async function rejected(args: Json) {
  const { result, text } = await connection.call('run_query', args);
  expect(result.isError, `expected an error, got: ${text}`).toBe(true);
  return text;
}

const septOct = [{ $gte: '2026-09-01' }, { $lte: '2026-10-31' }];

describe('run_query: answering questions with aggregates', () => {
  it('totals spending by category, biggest spender first, in major units', async () => {
    const { rows, columns } = await query({
      table: 'transactions',
      filter: { date: septOct, 'category.name': { $ne: null } },
      select: ['category.name', { total: { $sum: '$amount' } }],
      group_by: ['category.name'],
      order_by: [{ $sum: '$amount', $dir: 'asc' }],
    });

    expect(columns).toEqual(['category.name', 'total']);
    expect(rows).toEqual([
      { 'category.name': 'General', total: -150 },
      { 'category.name': 'Food', total: -127.75 },
      { 'category.name': 'Bills', total: -15.99 },
    ]);
  });

  it('totals by month, with months written YYYY-MM', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { 'category.name': 'Food' },
      select: [{ month: { $month: '$date' } }, { total: { $sum: '$amount' } }],
      group_by: [{ $month: '$date' }],
      order_by: [{ $month: '$date' }],
    });

    expect(rows).toEqual([
      { month: '2026-08', total: -12.34 },
      { month: '2026-09', total: -127.75 },
    ]);
  });

  it('calculates a single figure', async () => {
    const spent = await query({
      table: 'transactions',
      filter: { 'payee.name': 'Costco' },
      calculate: { $sum: '$amount' },
    });
    const visits = await query({
      table: 'transactions',
      filter: { 'payee.name': 'Costco' },
      calculate: { $count: '$id' },
    });

    expect(spent.rows).toEqual([{ result: -247.75 }]);
    expect(spent.columns).toEqual(['result']);
    expect(visits.rows).toEqual([{ result: 3 }]);
  });

  it('answers "top payees by spending" with a function in order_by', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: {
        date: septOct,
        amount: { $lt: 0 },
        'payee.name': { $ne: null },
      },
      select: ['payee.name', { total: { $sum: '$amount' } }],
      group_by: ['payee.name'],
      order_by: [{ $sum: '$amount', $dir: 'asc' }],
      limit: 2,
    });

    // The 200.00 transfer to Brokerage has a payee too.
    expect(rows).toEqual([
      { 'payee.name': 'Costco', total: -247.75 },
      { 'payee.name': 'Brokerage', total: -200 },
    ]);
  });
});

describe('run_query: money in filters is in major units', () => {
  it('compares against amounts written in dollars', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { date: septOct, amount: { $lt: -100 } },
      select: ['date', 'amount'],
      order_by: [{ amount: 'asc' }],
    });

    expect(rows).toEqual([
      { date: '2026-09-15', amount: -200 },
      { date: '2026-10-02', amount: -120 },
    ]);
  });

  it('treats a bare number as "equals"', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { amount: -15.99 },
      select: ['date', 'payee.name', 'amount'],
    });

    expect(rows).toEqual([
      { date: '2026-09-12', 'payee.name': 'Netflix', amount: -15.99 },
    ]);
  });

  it('converts every number in a $oneof, including ones floats get wrong', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { amount: { $oneof: [-9.99, -15.99, -12.34] } },
      select: ['amount'],
      order_by: ['amount'],
    });

    expect(rows.map(row => row.amount)).toEqual([-15.99, -12.34, -9.99]);
  });

  it('converts inside $and and $or', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: {
        date: septOct,
        $or: [{ amount: { $gte: 1000 } }, { amount: { $lte: -150 } }],
      },
      select: ['amount'],
      order_by: ['amount'],
    });

    expect(rows.map(row => row.amount)).toEqual([-200, 2500]);
  });

  it('turns amounts back into major units after $abs', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { 'payee.name': 'Netflix' },
      select: [{ size: { $abs: '$amount' } }],
    });

    expect(rows).toEqual([{ size: 15.99 }]);
  });

  it('leaves counts alone: they are not money', async () => {
    const { rows } = await query({
      table: 'transactions',
      select: [{ n: { $count: '$id' } }],
      filter: { date: septOct },
    });

    expect(rows).toEqual([{ n: 9 }]);
  });

  it('formats money columns, and only those, in the text', async () => {
    const { text } = await query({
      table: 'transactions',
      filter: { 'payee.name': 'Netflix' },
      select: ['date', 'amount', { n: { $count: '$id' } }],
      group_by: ['date', 'amount'],
    });

    expect(text).toContain('date | amount | n');
    expect(text).toContain('2026-09-12 | -15.99 | 1');
  });
});

describe('run_query: dates', () => {
  it('matches a date exactly and returns it unchanged', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { date: '2026-09-10' },
      select: ['date', 'amount'],
    });

    expect(rows).toEqual([{ date: '2026-09-10', amount: -42.25 }]);
  });

  it('includes both ends of a range', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { date: [{ $gte: '2026-09-03' }, { $lte: '2026-09-12' }] },
      select: ['date'],
      order_by: ['date'],
    });

    expect(rows.map(row => row.date)).toEqual([
      '2026-09-03',
      '2026-09-10',
      '2026-09-12',
    ]);
  });

  it('compares part of a date with $transform', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { date: { $transform: '$month', $eq: '2026-09' } },
      calculate: { $count: '$id' },
    });

    // Costco x2, Netflix, Employer, and both sides of the transfer.
    expect(rows).toEqual([{ result: 6 }]);
  });
});

describe('run_query: other tables', () => {
  it('lists accounts, filtering on yes/no fields', async () => {
    const open = await query({
      table: 'accounts',
      filter: { closed: false },
      select: ['name', 'offbudget'],
      order_by: ['name'],
    });
    const offBudget = await query({
      table: 'accounts',
      filter: { offbudget: true },
      select: ['name'],
    });

    expect(open.rows).toEqual([
      { name: 'Brokerage', offbudget: true },
      { name: 'Checking', offbudget: false },
      { name: 'Savings', offbudget: false },
    ]);
    expect(offBudget.rows).toEqual([{ name: 'Brokerage' }]);
  });

  it('follows references to read a category group name', async () => {
    const { rows } = await query({
      table: 'categories',
      filter: { hidden: true },
      select: ['name', 'group.name'],
      order_by: ['name'],
    });

    expect(rows).toEqual([
      { name: 'Old Hobby', 'group.name': 'Archive' },
      { name: 'Retired Extra', 'group.name': 'Extras' },
    ]);
  });

  it('searches payees, including names with an apostrophe', async () => {
    const byName = await query({
      table: 'payees',
      filter: { name: { $like: "%joe's%" } },
      select: ['name'],
    });

    expect(byName.rows).toEqual([{ name: "Trader Joe's" }]);
  });

  it('shows schedules with their amounts in major units', async () => {
    const { rows } = await query({
      table: 'schedules',
      filter: { name: { $oneof: ['Netflix', 'Gym'] } },
      order_by: ['name'],
    });

    expect(rows).toMatchObject([
      {
        name: 'Gym',
        _amount: { num1: -60, num2: -40 },
        _amountOp: 'isbetween',
      },
      {
        name: 'Netflix',
        _amount: -15.99,
        _amountOp: 'is',
        '_payee.name': 'Netflix',
        '_account.name': 'Checking',
      },
    ]);
  });

  it('uses sensible columns when select is left out', async () => {
    const { columns } = await query({ table: 'payees', limit: 1 });

    expect(columns).toEqual(['id', 'name', 'transfer_acct']);
  });

  it('can return every field of a table', async () => {
    const { columns } = await query({
      table: 'accounts',
      select: ['*'],
      limit: 1,
    });

    expect(columns).toEqual(
      expect.arrayContaining(['id', 'name', 'offbudget', 'closed']),
    );
    expect(columns).not.toContain('tombstone');
  });
});

describe('run_query: limits', () => {
  it('stops at the limit and says more rows exist', async () => {
    const { rows, truncated, row_count, text } = await query({
      table: 'transactions',
      limit: 2,
    });

    expect(rows).toHaveLength(2);
    expect(row_count).toBe(2);
    expect(truncated).toBe(true);
    expect(text).toContain('more rows matched than the limit of 2');
  });

  it('does not claim truncation when everything fit', async () => {
    const { truncated } = await query({
      table: 'transactions',
      filter: { 'payee.name': 'Costco' },
      limit: 3,
    });

    expect(truncated).toBe(false);
  });

  it('says so when nothing matches', async () => {
    const { rows, text } = await query({
      table: 'transactions',
      filter: { 'payee.name': 'No Such Merchant' },
    });

    expect(rows).toEqual([]);
    expect(text).toBe('No rows.');
  });

  it.each([0, 1001, 1.5])('rejects the limit %s', async limit => {
    const text = await rejected({ table: 'payees', limit });

    expect(text).toContain('Input validation error');
  });
});

describe('run_query: queries it refuses, with a reason', () => {
  it('rejects a table that cannot be queried', async () => {
    const text = await rejected({ table: 'preferences' });

    expect(text).toContain('Input validation error');
    expect(text).toContain('transactions');
  });

  it('suggests the right field for a wrong one', async () => {
    const text = await rejected({
      table: 'transactions',
      filter: { payee_name: 'Costco' },
    });

    expect(text).toContain(
      'unknown field "payee_name" on table "transactions"',
    );
    expect(text).toContain('Did you mean: payee, payee.name');
  });

  it('lists the fields when nothing is close', async () => {
    const text = await rejected({
      table: 'transactions',
      select: ['merchant'],
    });

    expect(text).toContain('unknown field "merchant"');
    expect(text).toContain('Fields: id,');
    expect(text).toContain('Follow a reference with a dot');
  });

  it('rejects fields that hold raw bank data or bookkeeping', async () => {
    for (const field of ['raw_synced_data', 'tombstone', 'error']) {
      const text = await rejected({ table: 'transactions', select: [field] });

      expect(text).toContain(`unknown field "${field}"`);
    }
  });

  it('says where a bad path went wrong', async () => {
    expect(
      await rejected({ table: 'transactions', select: ['payee.nme'] }),
    ).toContain('on table "payees" (reached through "payee")');
    expect(
      await rejected({ table: 'transactions', select: ['amount.value'] }),
    ).toContain('"amount" is a plain integer field');
  });

  it('rejects an amount written as text', async () => {
    const text = await rejected({
      table: 'transactions',
      filter: { amount: { $lt: '-50' } },
    });

    expect(text).toContain('amounts are numbers in major units');
  });

  it('rejects an impossible or mis-formatted date', async () => {
    expect(
      await rejected({ table: 'transactions', filter: { date: '2026-02-30' } }),
    ).toContain('is not a date written YYYY-MM-DD');
    expect(
      await rejected({ table: 'transactions', filter: { date: '09/01/2026' } }),
    ).toContain('is not a date written YYYY-MM-DD');
    expect(
      await rejected({
        table: 'transactions',
        filter: { date: { $transform: '$month', $eq: '2026-09-01' } },
      }),
    ).toContain('is not a date written YYYY-MM');
  });

  it('rejects unknown operators and functions, naming the valid ones', async () => {
    expect(
      await rejected({
        table: 'transactions',
        filter: { amount: { $between: [1, 2] } },
      }),
    ).toContain('unknown operator "$between"');
    expect(
      await rejected({
        table: 'transactions',
        select: [{ x: { $condition: { amount: 1 } } }],
      }),
    ).toContain('unknown function "$condition"');
  });

  it('rejects the mistakes models actually make with select', async () => {
    // A bare field name inside an expression is a literal string.
    expect(
      await rejected({
        table: 'transactions',
        select: [{ payee: 'payee.name' }],
      }),
    ).toContain('Write "$payee.name"');
    // A function with no name.
    expect(
      await rejected({
        table: 'transactions',
        select: [{ $sum: '$amount' }],
      }),
    ).toContain('give the expression a name');
    // A reference to nothing.
    expect(
      await rejected({ table: 'transactions', select: [{ x: '$' }] }),
    ).toContain('"$" on its own is not a field');
  });

  it('explains that an alias cannot point straight at a dotted reference', async () => {
    const text = await rejected({
      table: 'transactions',
      select: [{ category: '$category.name' }],
    });

    expect(text).toContain(
      'an alias cannot point straight at "$category.name"',
    );
    expect(text).toContain('List "category.name" as a plain field');
  });

  it('will not mix calculate with select, group_by or order_by', async () => {
    const text = await rejected({
      table: 'transactions',
      calculate: { $sum: '$amount' },
      select: ['date'],
    });

    expect(text).toContain('calculate returns a single value');
  });

  it('rejects a bad order direction', async () => {
    expect(
      await rejected({
        table: 'transactions',
        order_by: [{ date: 'sideways' }],
      }),
    ).toContain('the direction must be "asc" or "desc"');
  });

  it('passes on the reason when the engine itself rejects a query', async () => {
    const text = await rejected({
      table: 'transactions',
      select: [{ total: { $sum: '$notes' } }],
    });

    expect(text).toContain('The query was rejected by Actual:');
  });
});

describe('run_query: text that looks like query syntax is only text', () => {
  const injection = "x') OR 1=1 --";

  it('refuses quotes where the engine would put them into the query as-is', async () => {
    // Values compared with an id field, and the values of a $oneof.
    expect(
      await rejected({
        table: 'transactions',
        filter: { account: injection },
      }),
    ).toContain('holds ids');
    expect(
      await rejected({
        table: 'transactions',
        filter: { 'payee.name': { $oneof: ['Costco', injection] } },
      }),
    ).toContain('$oneof values cannot contain a single quote');
  });

  it('points a name at the name field when it was given to an id field', async () => {
    const text = await rejected({
      table: 'transactions',
      filter: { payee: 'Trader Joe' },
    });

    expect(text).toContain('To match by name, filter on "payee.name" instead');
  });

  it.each([
    ['equals', { 'payee.name': injection }],
    ['$like', { 'payee.name': { $like: `%${injection}%` } }],
    ['$ne', { notes: { $ne: injection } }],
  ])(
    'matches nothing, and breaks nothing, in a %s on a text field',
    async (_op, filter) => {
      const { rows } = await query({
        table: 'transactions',
        filter,
        calculate: undefined,
        select: ['id'],
      });

      // $ne matches every row with other notes; the others match nothing. What
      // matters is that the text was compared, not executed.
      if ('notes' in filter) {
        expect(rows.length).toBeGreaterThan(0);
      } else {
        expect(rows).toEqual([]);
      }
    },
  );

  it('accepts ids that really are ids', async () => {
    const { rows } = await query({
      table: 'transactions',
      filter: { account: fixture.accounts.savings, date: septOct },
      select: ['amount'],
    });

    expect(rows).toEqual([{ amount: -200 }]);
  });
});
