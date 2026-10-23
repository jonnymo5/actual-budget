import { z } from 'zod';

import { queryRows } from '#actual/query';
import { transactionRowSchema } from '#actual/transactions';
import { connectTestClient } from '#testing/client';
import { seedFixture } from '#testing/fixture';
import type { Fixture } from '#testing/fixture';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import {
  addTransactionsWithoutRules,
  fail,
  findTransactionIds,
  succeed,
} from '#testing/tools';

// Every test gets a budget of its own, because most of them change it. On top
// of the shared household (see testing/fixture.ts) it has five more Checking
// transactions without a category:
//   Costco  -30.00 (10-10), -20.00 (10-12), -50.00 (10-14)
//   Spotify  -9.99 (10-01), -9.99 (10-15)
let budget: TestBudget;
let fixture: Fixture;
let connection: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  budget = await createTestBudget();
  fixture = await budget.use(async ctx => {
    const seeded = await seedFixture(ctx);
    const spotify = await ctx.api.createPayee({ name: 'Spotify' });
    await addTransactionsWithoutRules(ctx, seeded.accounts.checking, [
      { date: '2026-10-10', amount: -30, payee: seeded.payees.costco },
      { date: '2026-10-12', amount: -20, payee: seeded.payees.costco },
      { date: '2026-10-14', amount: -50, payee: seeded.payees.costco },
      { date: '2026-10-01', amount: -9.99, payee: spotify },
      { date: '2026-10-15', amount: -9.99, payee: spotify },
    ]);
    return seeded;
  });
  connection = await connectTestClient({ session: budget.session });
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

const groupSchema = z.object({
  payee: z.string().nullable(),
  count: z.number(),
  total_amount: z.number(),
  first_date: z.string(),
  last_date: z.string(),
  usual_categories: z.array(
    z.object({ category: z.string(), count: z.number() }),
  ),
  transactions: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      amount: z.number(),
      imported_payee: z.string().nullable(),
    }),
  ),
});
const uncategorizedSchema = z.object({
  total_count: z.number(),
  total_amount: z.number(),
  group_count: z.number(),
  groups: z.array(groupSchema),
  offset: z.number(),
  has_more: z.boolean(),
});
const categorizeSchema = z.object({
  requested: z.number(),
  change_count: z.number(),
  unchanged_count: z.number(),
  skipped: z.array(
    z.object({ transaction_id: z.string(), reason: z.string() }),
  ),
  by_category: z.array(
    z.object({
      category: z.string(),
      count: z.number(),
      total_amount: z.number(),
    }),
  ),
  samples: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          from: z.string().nullable(),
          to: z.string().nullable(),
        }),
      ),
    }),
  ),
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});
const updateSchema = z.object({
  changed: z.boolean(),
  transaction: z.object({
    id: z.string(),
    changes: z.array(
      z.object({
        field: z.string(),
        from: z.string().nullable(),
        to: z.string().nullable(),
      }),
    ),
  }),
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});
const pageSchema = z.object({ transactions: z.array(transactionRowSchema) });

async function uncategorized(args: Record<string, unknown> = {}) {
  return (
    await succeed(connection, 'get_uncategorized', args, uncategorizedSchema)
  ).data;
}

async function transactionsOf(payee: string) {
  const { data } = await succeed(
    connection,
    'get_transactions',
    { payee, start_date: '2019-01-01', end_date: '2026-12-31' },
    pageSchema,
  );
  return data.transactions;
}

const uncategorizedIds = (payee: string) =>
  findTransactionIds(budget, {
    'payee.name': payee,
    category: null,
  });

describe('get_uncategorized', () => {
  it('groups what needs a category by payee, biggest groups first', async () => {
    const page = await uncategorized();

    // Three with no payee (Savings opening balance, Old Card in and out), three
    // Costco, two Spotify, then one each. Transfers and the off-budget
    // Brokerage account are left out.
    expect(page.total_count).toBe(10);
    expect(page.total_amount).toBe(2870.03);
    expect(page.group_count).toBe(5);
    expect(page.has_more).toBe(false);
    expect(
      page.groups.map(group => [group.payee, group.count, group.total_amount]),
    ).toEqual([
      [null, 3, 500],
      ['Costco', 3, -100],
      ['Spotify', 2, -19.98],
      ['Employer', 1, 2500],
      ['Mystery Vendor', 1, -9.99],
    ]);
  });

  it('shows the dates of a group and its newest transactions first', async () => {
    const page = await uncategorized();
    const costco = page.groups.find(group => group.payee === 'Costco');

    expect(costco).toMatchObject({
      first_date: '2026-10-10',
      last_date: '2026-10-14',
    });
    expect(costco?.transactions.map(t => [t.date, t.amount])).toEqual([
      ['2026-10-14', -50],
      ['2026-10-12', -20],
      ['2026-10-10', -30],
    ]);
  });

  it('says which categories the payee already uses, most common first', async () => {
    const page = await uncategorized();
    const byPayee = new Map(page.groups.map(group => [group.payee, group]));

    expect(byPayee.get('Costco')?.usual_categories).toEqual(
      [
        { category: 'Food', category_id: fixture.categories.food, count: 2 },
        {
          category: 'General',
          category_id: fixture.categories.general,
          count: 1,
        },
      ].map(({ category, count }) => ({ category, count })),
    );
    // Nothing is known about a payee that has never been categorized.
    expect(byPayee.get('Spotify')?.usual_categories).toEqual([]);
    expect(byPayee.get(null)?.usual_categories).toEqual([]);
  });

  it('pages through the groups', async () => {
    const first = await uncategorized({ limit: 2 });
    expect(first.groups.map(group => group.payee)).toEqual([null, 'Costco']);
    expect(first.has_more).toBe(true);
    // The totals cover everything, not just the page.
    expect(first.total_count).toBe(10);

    const last = await uncategorized({ limit: 2, offset: 4 });
    expect(last.groups.map(group => group.payee)).toEqual(['Mystery Vendor']);
    expect(last.has_more).toBe(false);
  });

  it('can be limited to dates and to one account', async () => {
    const october = await uncategorized({ start_date: '2026-10-01' });
    expect(october.groups.map(group => group.payee)).toEqual([
      'Costco',
      'Spotify',
      'Mystery Vendor',
    ]);
    expect(october.total_count).toBe(6);

    const savings = await uncategorized({
      account_id: fixture.accounts.savings,
    });
    expect(savings.total_count).toBe(1);
    expect(savings.groups[0]).toMatchObject({ payee: null, total_amount: 500 });
  });

  it('shrinks as transactions get categorized', async () => {
    expect((await uncategorized()).total_count).toBe(10);
    const ids = await uncategorizedIds('Spotify');
    await succeed(
      connection,
      'categorize_transactions',
      {
        assignments: ids.map(id => ({ transaction_id: id, category: 'Bills' })),
        dry_run: false,
      },
      categorizeSchema,
    );

    const after = await uncategorized();
    expect(after.total_count).toBe(8);
    expect(after.groups.map(group => group.payee)).not.toContain('Spotify');
  });

  it('says so when nothing is left', async () => {
    const everything = (await uncategorized({ limit: 100 })).groups.flatMap(
      group => group.transactions,
    );
    expect(everything.length).toBeGreaterThan(0);

    const { text } = await connection.call('get_uncategorized', {
      start_date: '2030-01-01',
    });
    expect(text).toBe('Nothing is uncategorized.');
  });

  it('rejects an unknown account and backwards dates', async () => {
    expect(
      await fail(connection, 'get_uncategorized', { account_id: 'nope' }),
    ).toMatch(/unknown account_id "nope"/);
    expect(
      await fail(connection, 'get_uncategorized', {
        start_date: '2026-10-02',
        end_date: '2026-10-01',
      }),
    ).toMatch(/must not be after end_date/);
  });
});

describe('categorize_transactions', () => {
  it('previews by default and changes nothing', async () => {
    const ids = await uncategorizedIds('Costco');
    const { data, text } = await succeed(
      connection,
      'categorize_transactions',
      {
        assignments: ids.map(id => ({ transaction_id: id, category: 'Food' })),
      },
      categorizeSchema,
    );

    expect(data).toMatchObject({
      dry_run: true,
      requested: 3,
      change_count: 3,
      unchanged_count: 0,
      skipped: [],
    });
    expect(data.by_category).toEqual(
      [
        {
          category_id: fixture.categories.food,
          category: 'Food',
          count: 3,
          total_amount: -100,
        },
      ].map(({ category, count, total_amount }) => ({
        category,
        count,
        total_amount,
      })),
    );
    expect(data.samples).toHaveLength(3);
    expect(data.samples[0].changes).toEqual([
      { field: 'category', from: null, to: 'Food' },
    ]);
    expect(text).toMatch(
      /^DRY RUN - nothing was changed\.\nWould categorize 3 of 3/,
    );

    expect(await uncategorizedIds('Costco')).toHaveLength(3);
  });

  it('applies the change when asked, and reports what it did', async () => {
    const ids = await uncategorizedIds('Costco');
    const syncsBefore = budget.syncCount();
    const { data, text } = await succeed(
      connection,
      'categorize_transactions',
      {
        assignments: ids.map(id => ({ transaction_id: id, category: 'food' })),
        dry_run: false,
      },
      categorizeSchema,
    );

    expect(data).toMatchObject({ dry_run: false, change_count: 3 });
    expect(text).toMatch(/^Categorized 3 of 3/);
    expect(budget.syncCount()).toBeGreaterThan(syncsBefore);

    const costco = await transactionsOf('Costco');
    expect(costco).toHaveLength(6);
    expect(costco.every(row => row.category !== null)).toBe(true);
    expect(costco.filter(row => row.category === 'Food')).toHaveLength(5);
  });

  it('gives each transaction its own category', async () => {
    const [costco] = await uncategorizedIds('Costco');
    const [spotify] = await uncategorizedIds('Spotify');
    const { data } = await succeed(
      connection,
      'categorize_transactions',
      {
        assignments: [
          { transaction_id: costco, category: fixture.categories.food },
          { transaction_id: spotify, category: 'Bills' },
        ],
        dry_run: false,
      },
      categorizeSchema,
    );

    expect(
      data.by_category.map(entry => [entry.category, entry.count]),
    ).toEqual(
      expect.arrayContaining([
        ['Food', 1],
        ['Bills', 1],
      ]),
    );
    const rows = new Map(
      (await transactionsOf('Spotify')).map(row => [row.id, row.category]),
    );
    expect(rows.get(spotify)).toBe('Bills');
  });

  it('leaves transactions that already have the category alone', async () => {
    const [food] = await findTransactionIds(budget, {
      'payee.name': 'Costco',
      amount: -8550,
    });
    const { data } = await succeed(
      connection,
      'categorize_transactions',
      { assignments: [{ transaction_id: food, category: 'Food' }] },
      categorizeSchema,
    );

    expect(data).toMatchObject({ change_count: 0, unchanged_count: 1 });
  });

  it('skips what Actual does not categorize, and says why', async () => {
    const [transfer] = await findTransactionIds(budget, {
      account: fixture.accounts.savings,
      transfer_id: { $ne: null },
    });
    const [offBudget] = await findTransactionIds(budget, {
      account: fixture.accounts.brokerage,
      notes: 'Opening balance',
    });
    const [employer] = await uncategorizedIds('Employer');

    const { data } = await succeed(
      connection,
      'categorize_transactions',
      {
        assignments: [transfer, offBudget, employer].map(id => ({
          transaction_id: id,
          category: 'Food',
        })),
        dry_run: false,
      },
      categorizeSchema,
    );

    expect(data.change_count).toBe(1);
    expect(data.skipped).toEqual([
      { transaction_id: transfer, reason: expect.stringMatching(/transfer/) },
      {
        transaction_id: offBudget,
        reason: expect.stringMatching(/off-budget/),
      },
    ]);
    // Neither skipped transaction was touched.
    const rows = await budget.use(ctx =>
      queryRows(
        ctx,
        ctx.api
          .q('transactions')
          .filter({ id: { $oneof: [transfer, offBudget] } })
          .select(['id', 'category']),
        z.object({ id: z.string(), category: z.string().nullable() }),
      ),
    );
    expect(rows.map(row => row.category)).toEqual([null, null]);
  });

  it('skips the summary line of a split', async () => {
    const parent = await budget.use(async ctx => {
      await ctx.api.addTransactions(fixture.accounts.checking, [
        {
          date: '2026-10-16',
          amount: ctx.amounts.toMinor(-60),
          payee_name: 'Target',
          subtransactions: [
            {
              amount: ctx.amounts.toMinor(-40),
              category: fixture.categories.food,
            },
            {
              amount: ctx.amounts.toMinor(-20),
              category: fixture.categories.general,
            },
          ],
        },
      ]);
      const [parentRow] = await queryRows(
        ctx,
        ctx.api
          .q('transactions')
          .filter({ is_parent: true })
          .select(['id'])
          .options({ splits: 'all' }),
        z.object({ id: z.string() }),
      );
      return parentRow.id;
    });

    const { data } = await succeed(
      connection,
      'categorize_transactions',
      { assignments: [{ transaction_id: parent, category: 'Food' }] },
      categorizeSchema,
    );
    expect(data.change_count).toBe(0);
    expect(data.skipped[0].reason).toMatch(/split/);
  });

  it('changes nothing at all when any id or category is wrong', async () => {
    const [good] = await uncategorizedIds('Costco');
    const unknown = await fail(connection, 'categorize_transactions', {
      assignments: [
        { transaction_id: good, category: 'Food' },
        { transaction_id: 'no-such-id', category: 'Food' },
      ],
      dry_run: false,
    });
    expect(unknown).toMatch(/1 transaction_id value\(s\) are not transactions/);
    expect(unknown).toContain('no-such-id');
    expect(unknown).toMatch(/Nothing was changed/);

    const badCategory = await fail(connection, 'categorize_transactions', {
      assignments: [{ transaction_id: good, category: 'Grocerys' }],
      dry_run: false,
    });
    expect(badCategory).toMatch(/unknown category "Grocerys"/);

    expect(await uncategorizedIds('Costco')).toHaveLength(3);
  });

  it('suggests close category names', async () => {
    const [id] = await uncategorizedIds('Costco');
    const message = await fail(connection, 'categorize_transactions', {
      assignments: [{ transaction_id: id, category: 'Foo' }],
    });
    // "Foo" is a piece of "Food", so that is the suggestion.
    expect(message).toMatch(/Did you mean: Food/);
  });

  it('does not let an id smuggle in a query', async () => {
    const message = await fail(connection, 'categorize_transactions', {
      assignments: [
        { transaction_id: "x' OR 1=1 --", category: 'Food' },
        {
          transaction_id: 'y"); DROP TABLE transactions; --',
          category: 'Food',
        },
      ],
      dry_run: false,
    });
    expect(message).toMatch(/2 transaction_id value\(s\) are not transactions/);
    expect((await uncategorized()).total_count).toBe(10);
  });

  it('refuses the same transaction twice and an empty list', async () => {
    const [id] = await uncategorizedIds('Costco');
    expect(
      await fail(connection, 'categorize_transactions', {
        assignments: [
          { transaction_id: id, category: 'Food' },
          { transaction_id: id, category: 'General' },
        ],
      }),
    ).toMatch(/appears more than once/);
    await fail(connection, 'categorize_transactions', { assignments: [] });
  });

  it('lists only the first twenty changes but counts them all', async () => {
    await budget.use(async ctx => {
      const shop = await ctx.api.createPayee({ name: 'Bulk Shop' });
      await addTransactionsWithoutRules(
        ctx,
        fixture.accounts.checking,
        Array.from({ length: 25 }, (_, n) => ({
          date: '2026-09-02',
          amount: -1 - n,
          payee: shop,
        })),
      );
    });
    const ids = await findTransactionIds(budget, { 'payee.name': 'Bulk Shop' });

    const { data, text } = await succeed(
      connection,
      'categorize_transactions',
      {
        assignments: ids.map(id => ({
          transaction_id: id,
          category: 'General',
        })),
      },
      categorizeSchema,
    );
    expect(data.change_count).toBe(25);
    expect(data.samples).toHaveLength(20);
    expect(text).toMatch(/and 5 more/);
  });
});

describe('update_transaction', () => {
  it('previews a change to several fields without making it', async () => {
    const [id] = await uncategorizedIds('Mystery Vendor');
    const { data, text } = await succeed(
      connection,
      'update_transaction',
      {
        transaction_id: id,
        category: 'General',
        payee: 'costco',
        notes: 'sorted out',
      },
      updateSchema,
    );

    expect(data).toMatchObject({ changed: true, dry_run: true });
    expect(data.transaction.changes).toEqual([
      { field: 'category', from: null, to: 'General' },
      { field: 'payee', from: 'Mystery Vendor', to: 'Costco' },
      { field: 'notes', from: null, to: 'sorted out' },
    ]);
    expect(text).toMatch(/^DRY RUN/);
    expect(await uncategorizedIds('Mystery Vendor')).toEqual([id]);
  });

  it('applies the change', async () => {
    const [id] = await uncategorizedIds('Mystery Vendor');
    await succeed(
      connection,
      'update_transaction',
      {
        transaction_id: id,
        category: fixture.categories.general,
        payee: fixture.payees.costco,
        notes: 'sorted out',
        dry_run: false,
      },
      updateSchema,
    );

    const costco = await transactionsOf('Costco');
    expect(costco.find(row => row.id === id)).toMatchObject({
      payee: 'Costco',
      category: 'General',
      notes: 'sorted out',
      amount: -9.99,
    });
  });

  it('changes only the fields it is given', async () => {
    const [id] = await findTransactionIds(budget, {
      'payee.name': 'Costco',
      notes: 'weekly groceries',
    });
    await succeed(
      connection,
      'update_transaction',
      { transaction_id: id, category: 'Bills', dry_run: false },
      updateSchema,
    );

    const row = (await transactionsOf('Costco')).find(r => r.id === id);
    expect(row).toMatchObject({ category: 'Bills', notes: 'weekly groceries' });
  });

  it('clears the notes with an empty string', async () => {
    const [id] = await findTransactionIds(budget, {
      'payee.name': 'Costco',
      notes: 'weekly groceries',
    });
    await succeed(
      connection,
      'update_transaction',
      { transaction_id: id, notes: '', dry_run: false },
      updateSchema,
    );

    const row = (await transactionsOf('Costco')).find(r => r.id === id);
    expect(row?.notes === null || row?.notes === '').toBe(true);
  });

  it('reports no change when the transaction already has the values', async () => {
    const [id] = await findTransactionIds(budget, {
      'payee.name': 'Costco',
      notes: 'weekly groceries',
    });
    const { data, text } = await succeed(
      connection,
      'update_transaction',
      { transaction_id: id, category: 'Food', notes: 'weekly groceries' },
      updateSchema,
    );

    expect(data.changed).toBe(false);
    expect(data.transaction.changes).toEqual([]);
    expect(text).toMatch(/Nothing to change/);
  });

  it('lets a transfer have its notes changed but not its category or payee', async () => {
    const [transfer] = await findTransactionIds(budget, {
      account: fixture.accounts.savings,
      transfer_id: { $ne: null },
    });
    expect(
      await fail(connection, 'update_transaction', {
        transaction_id: transfer,
        category: 'Food',
      }),
    ).toMatch(/cannot be changed that way: it is a transfer between accounts/);

    const { data } = await succeed(
      connection,
      'update_transaction',
      { transaction_id: transfer, notes: 'to investments', dry_run: false },
      updateSchema,
    );
    expect(data.changed).toBe(true);
  });

  it('rejects unknown ids, categories and payees, and an empty edit', async () => {
    const [id] = await uncategorizedIds('Mystery Vendor');

    expect(
      await fail(connection, 'update_transaction', {
        transaction_id: 'nope',
        notes: 'x',
      }),
    ).toMatch(/unknown transaction_id "nope"/);
    expect(
      await fail(connection, 'update_transaction', {
        transaction_id: id,
        category: 'Nope',
      }),
    ).toMatch(/unknown category "Nope"/);
    expect(
      await fail(connection, 'update_transaction', {
        transaction_id: id,
        payee: 'Brand New Shop',
      }),
    ).toMatch(/unknown payee "Brand New Shop".*get_payees/);
    expect(
      await fail(connection, 'update_transaction', { transaction_id: id }),
    ).toMatch(/give at least one of category, payee or notes/);
  });

  it('will not set a transfer payee', async () => {
    const [id] = await uncategorizedIds('Mystery Vendor');
    const transferPayee = await budget.use(async ({ api }) => {
      const payees = await api.getPayees();
      return payees.find(payee => payee.transfer_acct)?.name ?? '';
    });
    expect(transferPayee).not.toBe('');

    expect(
      await fail(connection, 'update_transaction', {
        transaction_id: id,
        payee: transferPayee,
      }),
    ).toMatch(/transfer payee/);
  });
});
