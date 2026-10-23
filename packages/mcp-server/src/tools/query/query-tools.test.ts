import { z } from 'zod';

import type { ActualContext } from '#actual/session';
import { transactionRowSchema } from '#actual/transactions';
import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

// One seeded budget serves every test in this file; they only read from it.
//
// Checking: the template's 1000.00 starting balance, then the rows below.
//   1000.00 - 85.50 - 42.25 - 15.99 + 2500.00 - 120.00 - 9.99 - 30.00
//   = 3196.27
// Savings: 500.00 opening - 200.00 transferred out = 300.00
// Brokerage (off budget): 2500.00 opening + 200.00 transferred in = 2700.00
// Old Card: closed, 0.00
const EXPECTED = {
  checking: 3196.27,
  savings: 300,
  brokerage: 2700,
  onBudget: 3496.27,
  offBudget: 2700,
  all: 6196.27,
  // Everything dated 2026-09-01..2026-10-31: seven Checking rows plus both
  // sides of the Savings -> Brokerage transfer.
  septOctCount: 9,
  septOctNet: 2196.27,
};

let budget: TestBudget;
let ids: { checking: string; savings: string; brokerage: string; food: string };
let connection: Awaited<ReturnType<typeof connectTestClient>>;

async function categoryId(ctx: ActualContext, name: string) {
  const category = (await ctx.api.getCategories()).find(c => c.name === name);
  if (!category) throw new Error(`template has no category ${name}`);
  return category.id;
}

async function seed(ctx: ActualContext) {
  const { api, amounts } = ctx;
  const money = amounts.toMinor;

  const [checking] = await api.getAccounts();
  const savings = await api.createAccount({ name: 'Savings' });
  const brokerage = await api.createAccount({
    name: 'Brokerage',
    offbudget: true,
  });
  // Closing an account that has no transactions deletes it, so give it some
  // history that nets to zero (closing needs a zero balance).
  const oldCard = await api.createAccount({ name: 'Old Card' });
  await api.addTransactions(oldCard, [
    { date: '2025-01-01', amount: money(50), notes: 'Opening balance' },
    { date: '2025-06-01', amount: money(-50), notes: 'Paid off' },
  ]);
  await api.closeAccount(oldCard);

  // Enough categories that an unknown-category error has to cut its list.
  const extras = await api.createCategoryGroup({ name: 'Extras' });
  for (let n = 1; n <= 12; n++) {
    await api.createCategory({ name: `Extra ${n}`, group_id: extras });
  }

  const food = await categoryId(ctx, 'Food');
  const bills = await categoryId(ctx, 'Bills');
  const general = await categoryId(ctx, 'General');
  // Accounts made through the API get a transfer payee; the template's own
  // Checking account predates them, so transfers start from Savings instead.
  const transferToBrokerage = (await api.getPayees()).find(
    payee => payee.transfer_acct === brokerage,
  );
  if (!transferToBrokerage) throw new Error('no transfer payee for Brokerage');

  await api.addTransactions(
    savings,
    [
      { date: '2026-01-01', amount: money(500), notes: 'Opening balance' },
      {
        date: '2026-09-15',
        amount: money(-200),
        payee: transferToBrokerage.id,
      },
    ],
    { runTransfers: true },
  );
  await api.addTransactions(brokerage, [
    { date: '2026-01-01', amount: money(2500), notes: 'Opening balance' },
  ]);
  await api.addTransactions(checking.id, [
    {
      date: '2026-09-03',
      amount: money(-85.5),
      payee_name: 'Costco',
      category: food,
      notes: 'weekly groceries',
      cleared: false,
    },
    {
      date: '2026-09-10',
      amount: money(-42.25),
      payee_name: 'Costco',
      category: food,
    },
    {
      date: '2026-09-12',
      amount: money(-15.99),
      payee_name: 'Netflix',
      category: bills,
      cleared: true,
    },
    { date: '2026-09-20', amount: money(2500), payee_name: 'Employer' },
    {
      date: '2026-10-02',
      amount: money(-120),
      payee_name: 'Costco',
      category: general,
      notes: 'bulk party supplies',
    },
    {
      date: '2026-10-05',
      amount: money(-9.99),
      payee_name: 'Mystery Vendor',
    },
    {
      date: '2026-10-08',
      amount: money(-30),
      payee_name: 'Amazon',
      imported_payee: 'AMZN MKTP US*2K4',
      category: general,
    },
  ]);

  return { checking: checking.id, savings, brokerage, food };
}

beforeAll(async () => {
  budget = await createTestBudget();
  ids = await budget.use(seed);
  connection = await connectTestClient({ session: budget.session });
});

afterAll(async () => {
  await connection.close();
  await budget.dispose();
});

type Json = Record<string, unknown>;

// Tool results arrive as untyped JSON. Parsing them with these schemas keeps
// the tests free of casts and also checks the shape each tool promises.
const accountListSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      balance: z.number(),
      off_budget: z.boolean(),
      closed: z.boolean(),
    }),
  ),
  totals: z.object({
    on_budget: z.number(),
    off_budget: z.number(),
    all: z.number(),
  }),
});
const overviewSchema = accountListSchema.extend({
  category_groups: z.array(
    z.object({ name: z.string(), categories: z.array(z.string()) }),
  ),
  sync: z.object({
    last_synced_at: z.string().nullable(),
    last_error: z.string().nullable(),
  }),
});
const pageSchema = z.object({
  transactions: z.array(transactionRowSchema),
  total_count: z.number(),
  total_amount: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
});
const contentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);

async function call(name: string, args: Json = {}) {
  const result = await connection.client.callTool({ name, arguments: args });
  const text = contentSchema
    .parse(result.content)
    .map(block => block.text ?? '')
    .join('\n');
  return { result, text, data: result.structuredContent };
}

describe('server', () => {
  it('offers the three query tools, including in read-only mode', async () => {
    const readOnly = await connectTestClient({
      session: budget.session,
      readOnly: true,
    });
    const { tools } = await readOnly.client.listTools();

    expect(tools.map(tool => tool.name).sort()).toEqual([
      'get_overview',
      'get_transactions',
      'list_accounts',
    ]);
    await readOnly.close();
  });

  it('tells the model the conventions up front', () => {
    expect(connection.client.getInstructions()).toMatch(/get_overview first/);
    expect(connection.client.getInstructions()).toMatch(/dollars, not cents/);
  });

  it('states units and date formats in every tool description', async () => {
    const { tools } = await connection.client.listTools();

    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/major currency units/);
    }
    const transactions = tools.find(tool => tool.name === 'get_transactions');
    expect(transactions?.description).toMatch(/YYYY-MM-DD/);
  });
});

describe('get_overview', () => {
  it('summarises the budget', async () => {
    const { result, data, text } = await call('get_overview');

    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({
      budget_name: 'Default Test Db',
      decimal_places: 2,
      closed_account_count: 1,
      totals: {
        on_budget: EXPECTED.onBudget,
        off_budget: EXPECTED.offBudget,
        all: EXPECTED.all,
      },
      transactions: {
        count: 14,
        first_date: '2019-02-06',
        last_date: '2026-10-08',
      },
    });
    expect(text).toContain('Budget: Default Test Db');
    expect(text).toContain('Transactions: 14 from 2019-02-06 to 2026-10-08');
  });

  it('lists open accounts with balances in major units', async () => {
    const { data } = await call('get_overview');
    const { accounts } = overviewSchema.parse(data);

    expect(accounts.map(account => account.name).sort()).toEqual([
      'Brokerage',
      'Checking',
      'Savings',
    ]);
    expect(accounts.find(account => account.name === 'Checking')).toMatchObject(
      { id: ids.checking, balance: EXPECTED.checking, off_budget: false },
    );
    expect(
      accounts.find(account => account.name === 'Brokerage'),
    ).toMatchObject({ balance: EXPECTED.brokerage, off_budget: true });
  });

  it('lists category groups with their category names', async () => {
    const { data } = await call('get_overview');
    const { category_groups: groups } = overviewSchema.parse(data);

    const withFood = groups.find(group => group.categories.includes('Food'));
    expect(withFood).toBeDefined();
    expect(withFood?.categories).toEqual(
      expect.arrayContaining(['Food', 'Bills', 'General']),
    );
  });

  it("reports today's date, server version and sync state", async () => {
    const { data } = await call('get_overview');

    expect(data).toMatchObject({
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      // The test budget has no sync server.
      server_version: null,
      sync: { last_error: null },
    });
    expect(overviewSchema.parse(data).sync.last_synced_at).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });
});

describe('list_accounts', () => {
  it('hides closed accounts by default and totals the rest', async () => {
    const { data, text } = await call('list_accounts');

    const { accounts, totals } = accountListSchema.parse(data);
    expect(accounts.map(account => account.name).sort()).toEqual([
      'Brokerage',
      'Checking',
      'Savings',
    ]);
    expect(totals).toEqual({
      on_budget: EXPECTED.onBudget,
      off_budget: EXPECTED.offBudget,
      all: EXPECTED.all,
    });
    expect(text).toContain(`Checking: ${EXPECTED.checking.toFixed(2)}`);
    expect(text).toContain('Brokerage: 2700.00 (off budget)');
    expect(text).toContain(`[id: ${ids.savings}]`);
  });

  it('returns balances in major units, not cents', async () => {
    const { data } = await call('list_accounts');
    const { accounts } = accountListSchema.parse(data);

    expect(Object.fromEntries(accounts.map(a => [a.name, a.balance]))).toEqual({
      Checking: EXPECTED.checking,
      Savings: EXPECTED.savings,
      Brokerage: EXPECTED.brokerage,
    });
  });

  it('includes closed accounts on request', async () => {
    const { data, text } = await call('list_accounts', {
      include_closed: true,
    });

    const { accounts } = accountListSchema.parse(data);
    expect(accounts.find(account => account.name === 'Old Card')).toMatchObject(
      { closed: true, balance: 0 },
    );
    expect(text).toContain('Old Card: 0.00 (closed)');
  });
});

describe('get_transactions', () => {
  const septOct = { start_date: '2026-09-01', end_date: '2026-10-31' };

  const page = (data: unknown) => pageSchema.parse(data);

  it('returns the transactions in a date range, newest first, in major units', async () => {
    const { result, data } = await call('get_transactions', septOct);

    expect(result.isError).toBeFalsy();
    const { transactions, total_count, total_amount, has_more } = page(data);
    expect(total_count).toBe(EXPECTED.septOctCount);
    expect(total_amount).toBe(EXPECTED.septOctNet);
    expect(has_more).toBe(false);

    const dates = transactions.map(transaction => transaction.date);
    expect(dates).toEqual([...dates].sort().reverse());

    expect(transactions.find(t => t.payee === 'Netflix')?.cleared).toBe(true);

    const firstCostco = transactions.find(t => t.date === '2026-09-03');
    expect(firstCostco).toEqual({
      id: expect.any(String),
      date: '2026-09-03',
      account_id: ids.checking,
      account: 'Checking',
      payee_id: expect.any(String),
      payee: 'Costco',
      category_id: ids.food,
      category: 'Food',
      amount: -85.5,
      notes: 'weekly groceries',
      cleared: false,
      is_transfer: false,
    });
  });

  it('includes both end dates', async () => {
    const { data } = await call('get_transactions', {
      start_date: '2026-09-10',
      end_date: '2026-09-10',
    });

    expect(page(data).transactions.map(t => t.amount)).toEqual([-42.25]);

    const { data: neighbours } = await call('get_transactions', {
      start_date: '2026-09-04',
      end_date: '2026-09-09',
    });
    expect(page(neighbours).total_count).toBe(0);
  });

  it('answers "what did I spend at <payee>" from a fragment of the name', async () => {
    const { data, text } = await call('get_transactions', {
      ...septOct,
      payee: 'COSTCO',
    });

    expect(page(data).total_count).toBe(3);
    expect(page(data).total_amount).toBe(-247.75);
    expect(text).toContain('3 matching transaction(s), net -247.75');
  });

  it('matches the original bank description as well as the payee name', async () => {
    const byBankText = await call('get_transactions', {
      ...septOct,
      payee: 'amzn',
    });
    const byName = await call('get_transactions', {
      ...septOct,
      payee: 'amazon',
    });

    expect(page(byBankText.data).total_amount).toBe(-30);
    expect(page(byName.data).total_amount).toBe(-30);
  });

  it('filters by payee id', async () => {
    const { data: all } = await call('get_transactions', {
      ...septOct,
      payee: 'netflix',
    });
    const { payee_id: payeeId } = page(all).transactions[0];
    expect(payeeId).toEqual(expect.any(String));

    const { data } = await call('get_transactions', {
      ...septOct,
      payee: payeeId,
    });

    expect(page(data).transactions.map(t => t.payee)).toEqual(['Netflix']);
  });

  it('filters by account', async () => {
    const { data } = await call('get_transactions', {
      ...septOct,
      account_id: ids.savings,
    });

    expect(page(data).transactions).toEqual([
      expect.objectContaining({
        account: 'Savings',
        amount: -200,
        is_transfer: true,
      }),
    ]);
  });

  it('searches every account when none is given', async () => {
    const { data } = await call('get_transactions', septOct);
    const accounts = new Set(page(data).transactions.map(t => t.account));

    expect(accounts).toEqual(new Set(['Checking', 'Savings', 'Brokerage']));
  });

  it('filters by category name, ignoring case', async () => {
    const { data } = await call('get_transactions', {
      ...septOct,
      category: 'fOOd',
    });

    expect(page(data).transactions.map(t => t.amount)).toEqual([-42.25, -85.5]);
  });

  it('filters by category id', async () => {
    const { data } = await call('get_transactions', {
      ...septOct,
      category: ids.food,
    });

    expect(page(data).total_count).toBe(2);
  });

  it('filters by signed amount range', async () => {
    // Purchases between 10.00 and 100.00.
    const { data } = await call('get_transactions', {
      ...septOct,
      min_amount: -100,
      max_amount: -10,
    });

    expect(
      page(data)
        .transactions.map(t => t.amount)
        .sort((a, b) => a - b),
    ).toEqual([-85.5, -42.25, -30, -15.99]);
    expect(page(data).total_amount).toBe(-173.74);
  });

  it('searches notes, case-insensitively', async () => {
    const { data } = await call('get_transactions', {
      ...septOct,
      search_text: 'PARTY',
    });

    expect(page(data).transactions.map(t => t.notes)).toEqual([
      'bulk party supplies',
    ]);
  });

  it('combines filters', async () => {
    const { data } = await call('get_transactions', {
      ...septOct,
      payee: 'costco',
      category: 'food',
      max_amount: -50,
    });

    expect(page(data).transactions.map(t => t.amount)).toEqual([-85.5]);
  });

  it('pages through results without losing or repeating any', async () => {
    const first = page(
      (await call('get_transactions', { ...septOct, limit: 4 })).data,
    );
    const second = page(
      (await call('get_transactions', { ...septOct, limit: 4, offset: 4 }))
        .data,
    );
    const last = page(
      (await call('get_transactions', { ...septOct, limit: 4, offset: 8 }))
        .data,
    );

    expect(first.transactions).toHaveLength(4);
    expect(first.has_more).toBe(true);
    expect(second.has_more).toBe(true);
    expect(last.transactions).toHaveLength(1);
    expect(last.has_more).toBe(false);
    // Totals describe all matches, whichever page is returned.
    for (const result of [first, second, last]) {
      expect(result.total_count).toBe(EXPECTED.septOctCount);
      expect(result.total_amount).toBe(EXPECTED.septOctNet);
    }

    const allIds = [first, second, last].flatMap(p =>
      p.transactions.map(t => t.id),
    );
    expect(new Set(allIds).size).toBe(EXPECTED.septOctCount);
  });

  it('tells the model how to fetch the next page', async () => {
    const { text } = await call('get_transactions', { ...septOct, limit: 4 });

    expect(text).toContain('Showing 1-4');
    expect(text).toContain('More results: call again with offset 4.');
  });

  it('puts the id, payee and category in the text for clients that only show text', async () => {
    const { text, data } = await call('get_transactions', {
      ...septOct,
      payee: 'mystery',
    });

    const [row] = page(data).transactions;
    expect(text).toContain(
      `2026-10-05 | -9.99 | Mystery Vendor | (uncategorized) | Checking |  | [id: ${row.id}]`,
    );
  });

  it('labels transfers instead of calling them uncategorized', async () => {
    const { text } = await call('get_transactions', {
      ...septOct,
      account_id: ids.savings,
    });

    expect(text).toContain('(transfer)');
    expect(text).not.toContain('(uncategorized)');
  });

  it('returns an empty page, not an error, when nothing matches', async () => {
    const { result, data, text } = await call('get_transactions', {
      ...septOct,
      payee: 'no such merchant',
    });

    expect(result.isError).toBeFalsy();
    expect(data).toEqual({
      transactions: [],
      total_count: 0,
      total_amount: 0,
      offset: 0,
      has_more: false,
    });
    expect(text).toBe('No transactions matched.');
  });

  describe('input validation', () => {
    it('names the known accounts when the account id is unknown', async () => {
      const { result, text } = await call('get_transactions', {
        ...septOct,
        account_id: 'not-an-account',
      });

      expect(result.isError).toBe(true);
      expect(text).toContain('unknown account_id "not-an-account"');
      expect(text).toContain(`Checking (${ids.checking})`);
      expect(text).toContain(`Savings (${ids.savings})`);
    });

    it('suggests close category names when the category is unknown', async () => {
      const { result, text } = await call('get_transactions', {
        ...septOct,
        category: 'foo',
      });

      expect(result.isError).toBe(true);
      expect(text).toContain('unknown category "foo"');
      expect(text).toContain('Did you mean: Food');
    });

    it('lists available categories when nothing is close', async () => {
      const { text } = await call('get_transactions', {
        ...septOct,
        category: 'zzz',
      });

      expect(text).toContain('Available categories:');
      expect(text).toContain('Food');
    });

    it('says when it is showing only some of the categories, and where to find them all', async () => {
      const { text } = await call('get_transactions', {
        ...septOct,
        category: 'zzz',
      });

      expect(text).toMatch(
        /showing 15 of \d+; get_overview lists every category/,
      );
    });

    it('rejects a start date after the end date', async () => {
      const { result, text } = await call('get_transactions', {
        start_date: '2026-10-31',
        end_date: '2026-09-01',
      });

      expect(result.isError).toBe(true);
      expect(text).toContain(
        'start_date (2026-10-31) must not be after end_date',
      );
    });

    // The SDK turns bad arguments into an error result the model can read,
    // naming the offending field, before the tool runs.
    it.each([
      [
        'a date in the wrong format',
        { start_date: '09/01/2026' },
        'start_date',
      ],
      ['an impossible date', { start_date: '2026-02-30' }, 'start_date'],
      ['a missing start date', { start_date: undefined }, 'start_date'],
      ['a limit above the maximum', { limit: 501 }, 'limit'],
      ['a limit of zero', { limit: 0 }, 'limit'],
      ['a negative offset', { offset: -1 }, 'offset'],
      ['a fractional limit', { limit: 1.5 }, 'limit'],
    ])('rejects %s', async (_label, override, field) => {
      const { result, text } = await call('get_transactions', {
        ...septOct,
        ...override,
      });

      expect(result.isError).toBe(true);
      expect(text).toContain('Input validation error');
      expect(text).toContain(field);
    });
  });
});
