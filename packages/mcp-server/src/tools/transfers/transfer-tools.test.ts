import { z } from 'zod';

import { queryRows } from '#actual/query';
import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import {
  addTransactionsWithoutRules,
  fail,
  findTransactionIds,
  succeed,
} from '#testing/tools';

// Every test gets a budget of its own, because most of them link transfers.
// Main, Visa, Amex and Savings are on budget; Brokerage is a tracking account.
let budget: TestBudget;
let connection: Awaited<ReturnType<typeof connectTestClient>>;
let accounts: Record<
  'main' | 'visa' | 'amex' | 'savings' | 'brokerage',
  string
>;
let categories: { food: string; drawFund: string };
let payees: Record<'autopay' | 'thanks' | 'sale' | 'rent', string>;

beforeEach(async () => {
  budget = await createTestBudget();
  const world = await budget.use(async ({ api }) => {
    const found = {
      main: await api.createAccount({ name: 'Main' }),
      visa: await api.createAccount({ name: 'Visa' }),
      amex: await api.createAccount({ name: 'Amex' }),
      savings: await api.createAccount({ name: 'Savings' }),
      brokerage: await api.createAccount({
        name: 'Brokerage',
        offbudget: true,
      }),
    };
    const food = (await api.getCategories()).find(c => c.name === 'Food');
    const incomeGroup = (await api.getCategoryGroups()).find(g => g.is_income);
    if (!food || !incomeGroup) throw new Error('template is missing a group');
    const drawFund = await api.createCategory({
      name: 'Draw Fund',
      group_id: incomeGroup.id,
    });
    return {
      accounts: found,
      categories: { food: food.id, drawFund },
      payees: {
        autopay: await api.createPayee({ name: 'Visa Autopay' }),
        thanks: await api.createPayee({ name: 'Payment Thank You' }),
        sale: await api.createPayee({ name: 'Robinhood Credits' }),
        rent: await api.createPayee({ name: 'Landlord' }),
      },
    };
  });
  ({ accounts, categories, payees } = world);
  connection = await connectTestClient({ session: budget.session });
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

const sideSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  account: z.string().nullable(),
  off_budget: z.boolean(),
  payee: z.string().nullable(),
  category: z.string().nullable(),
});
const findSchema = z.object({
  window_days: z.number(),
  scanned: z.number(),
  clear_count: z.number(),
  needs_confirmation_count: z.number(),
  returned: z.number(),
  has_more: z.boolean(),
  matches: z.array(
    z.object({
      status: z.enum(['clear', 'needs_confirmation']),
      from: sideSchema,
      to: sideSchema.nullable(),
      alternatives: z.array(sideSchema),
      competing: z.array(sideSchema),
      days_apart: z.number().nullable(),
      reasons: z.array(z.string()),
    }),
  ),
});
const linkSchema = z.object({
  requested: z.number(),
  ready_count: z.number(),
  needs_confirmation_count: z.number(),
  skipped_count: z.number(),
  linked_count: z.number(),
  pairs: z.array(
    z.object({
      status: z.enum(['ready', 'needs_confirmation', 'skipped']),
      mode: z.string().nullable(),
      transaction_id: z.string(),
      from: sideSchema.nullable(),
      to: sideSchema.nullable(),
      create_in: z.string().nullable(),
      category_cleared: z.boolean(),
      reasons: z.array(z.string()),
      skipped_reason: z.string().nullable(),
      linked: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});
const summarySchema = z.object({
  total: z.number(),
  transaction_count: z.number(),
  savings_draws: z.object({ count: z.number(), total: z.number() }),
});

type Row = {
  date: string;
  amount: number;
  payee?: string;
  category?: string;
  notes?: string;
};

async function add(account: string, rows: Row[]) {
  await budget.use(ctx => addTransactionsWithoutRules(ctx, account, rows));
}

/** The id of the one transaction in `account` with this amount (major units). */
async function idOf(account: string, dollars: number, date?: string) {
  const found = await findTransactionIds(budget, {
    account,
    amount: Math.round(dollars * 100),
    ...(date ? { date } : {}),
  });
  expect(found, `${account} ${dollars} ${date ?? ''}`).toHaveLength(1);
  return found[0];
}

const stateSchema = z.object({
  id: z.string(),
  account: z.string(),
  amount: z.number(),
  transfer_id: z.string().nullable(),
  'payee.name': z.string().nullable(),
  'category.name': z.string().nullable(),
  'account.name': z.string().nullable(),
  notes: z.string().nullable(),
});

async function stateOf(ids: string[]) {
  const rows = await budget.use(ctx =>
    queryRows(
      ctx,
      ctx.api
        .q('transactions')
        .filter({ id: { $oneof: ids } })
        .select([
          'id',
          'account',
          'amount',
          'transfer_id',
          'payee.name',
          'category.name',
          'account.name',
          'notes',
        ]),
      stateSchema,
    ),
  );
  return new Map(rows.map(row => [row.id, row]));
}

async function count(account: string) {
  return (await findTransactionIds(budget, { account })).length;
}

function link(args: Record<string, unknown>) {
  return succeed(connection, 'link_transfers', args, linkSchema);
}

describe('find_transfer_candidates', () => {
  function find(args: Record<string, unknown> = {}) {
    return succeed(connection, 'find_transfer_candidates', args, findSchema);
  }

  it('finds a card payment that is on both accounts and calls it clear', async () => {
    await add(accounts.main, [
      { date: '2026-09-30', amount: -500, payee: payees.autopay },
    ]);
    await add(accounts.visa, [
      { date: '2026-10-01', amount: 500, payee: payees.thanks },
    ]);

    const { data, text } = await find();

    expect(data).toMatchObject({
      clear_count: 1,
      needs_confirmation_count: 0,
      returned: 1,
      has_more: false,
    });
    expect(data.matches[0]).toMatchObject({
      status: 'clear',
      days_apart: 1,
      reasons: [],
      from: { account: 'Main', amount: -500, payee: 'Visa Autopay' },
      to: { account: 'Visa', amount: 500, payee: 'Payment Thank You' },
    });
    expect(text).toContain('[clear]');
  });

  it('leaves out transactions that are transfers already', async () => {
    await budget.use(async ({ api, amounts }) => {
      const toVisa = (await api.getPayees()).find(
        payee => payee.transfer_acct === accounts.visa,
      );
      await api.addTransactions(
        accounts.main,
        [
          {
            date: '2026-09-30',
            amount: amounts.toMinor(-500),
            payee: toVisa?.id,
          },
        ],
        { runTransfers: true },
      );
    });

    const { data } = await find();
    expect(data.matches).toEqual([]);
    expect(data.clear_count).toBe(0);
  });

  it('asks about equal payments it cannot tell apart', async () => {
    await add(accounts.main, [
      { date: '2026-09-29', amount: -750 },
      { date: '2026-09-30', amount: -750 },
    ]);
    await add(accounts.visa, [{ date: '2026-10-01', amount: 750 }]);

    const { data } = await find();

    expect(data.clear_count).toBe(0);
    expect(data.needs_confirmation_count).toBe(2);
    for (const match of data.matches) {
      expect(match.reasons).toContain('several_possible_matches');
      expect(match.competing).toHaveLength(1);
    }
  });

  it("lists only the kind asked for, and only an account's own pairs", async () => {
    await add(accounts.main, [
      { date: '2026-09-30', amount: -500 },
      { date: '2026-09-10', amount: -90 },
    ]);
    await add(accounts.visa, [{ date: '2026-10-01', amount: 500 }]);
    await add(accounts.amex, [
      { date: '2026-09-10', amount: 90, category: categories.food },
    ]);

    const everything = await find();
    expect(everything.data).toMatchObject({
      clear_count: 1,
      needs_confirmation_count: 1,
    });

    const onlyAsk = await find({ status: 'needs_confirmation' });
    expect(onlyAsk.data.matches.map(m => m.status)).toEqual([
      'needs_confirmation',
    ]);
    expect(onlyAsk.data.matches[0].reasons).toEqual([
      'category_would_be_cleared',
    ]);
    // The counts cover every page, whatever is listed.
    expect(onlyAsk.data.clear_count).toBe(1);

    const visaOnly = await find({ account_id: accounts.visa });
    expect(visaOnly.data.matches).toHaveLength(1);
    expect(visaOnly.data.matches[0].to?.account).toBe('Visa');
  });

  it('narrows by date and window, and pages', async () => {
    await add(accounts.main, [
      { date: '2026-08-01', amount: -10 },
      { date: '2026-09-01', amount: -20 },
    ]);
    await add(accounts.visa, [
      { date: '2026-08-01', amount: 10 },
      { date: '2026-09-06', amount: 20 },
    ]);

    // Five days apart is outside the default window of four.
    expect((await find()).data.matches.map(m => m.from.amount)).toEqual([-10]);
    expect(
      (await find({ window_days: 7 })).data.matches.map(m => m.from.amount),
    ).toEqual([-10, -20]);
    expect(
      (await find({ window_days: 7, start_date: '2026-09-01' })).data.matches,
    ).toHaveLength(1);

    const page = await find({ window_days: 7, limit: 1 });
    expect(page.data).toMatchObject({ returned: 1, has_more: true });
  });

  it('refuses an unknown account and a backwards range', async () => {
    expect(
      await fail(connection, 'find_transfer_candidates', {
        account_id: 'nope',
      }),
    ).toMatch(/unknown account_id/);
    expect(
      await fail(connection, 'find_transfer_candidates', {
        start_date: '2026-10-01',
        end_date: '2026-09-01',
      }),
    ).toMatch(/must not be after/);
  });
});

describe('link_transfers', () => {
  async function cardPayment() {
    await add(accounts.main, [
      { date: '2026-09-30', amount: -500, payee: payees.autopay },
    ]);
    await add(accounts.visa, [
      { date: '2026-10-01', amount: 500, payee: payees.thanks },
    ]);
    return {
      out: await idOf(accounts.main, -500),
      into: await idOf(accounts.visa, 500),
    };
  }

  it('previews by default and changes nothing', async () => {
    const { out, into } = await cardPayment();

    const { data, text } = await link({
      pairs: [{ transaction_id: out, counterpart_id: into }],
    });

    expect(data).toMatchObject({
      dry_run: true,
      requested: 1,
      ready_count: 1,
      linked_count: 0,
    });
    expect(data.pairs[0]).toMatchObject({
      status: 'ready',
      mode: 'link_existing',
      from: { account: 'Main' },
      to: { account: 'Visa' },
      linked: false,
    });
    expect(text).toMatch(/Would link 1 of 1/);

    const state = await stateOf([out, into]);
    expect(state.get(out)?.transfer_id).toBeNull();
    expect(state.get(into)?.transfer_id).toBeNull();
  });

  it('links the two sides of a clear pair to each other, with transfer payees', async () => {
    const { out, into } = await cardPayment();

    const { data } = await link({
      pairs: [{ transaction_id: out, counterpart_id: into }],
      dry_run: false,
    });

    expect(data).toMatchObject({ dry_run: false, linked_count: 1 });
    expect(data.pairs[0].linked).toBe(true);
    const state = await stateOf([out, into]);
    expect(state.get(out)).toMatchObject({
      transfer_id: into,
      'payee.name': 'Visa',
    });
    expect(state.get(into)).toMatchObject({
      transfer_id: out,
      'payee.name': 'Main',
    });
    // No new transactions: this linked what was there, it did not mirror it.
    expect(await count(accounts.main)).toBe(1);
    expect(await count(accounts.visa)).toBe(1);

    // It is a real transfer now, so the finder no longer lists it...
    const found = await succeed(
      connection,
      'find_transfer_candidates',
      {},
      findSchema,
    );
    expect(found.data.matches).toEqual([]);
  });

  it("leaves each side's own notes alone", async () => {
    await add(accounts.main, [
      { date: '2026-09-30', amount: -500, notes: 'autopay memo' },
    ]);
    await add(accounts.visa, [
      { date: '2026-10-01', amount: 500, notes: 'statement credit' },
    ]);
    const out = await idOf(accounts.main, -500);
    const into = await idOf(accounts.visa, 500);

    await link({
      pairs: [{ transaction_id: out, counterpart_id: into }],
      dry_run: false,
    });

    const state = await stateOf([out, into]);
    expect(state.get(out)?.notes).toBe('autopay memo');
    expect(state.get(into)?.notes).toBe('statement credit');
  });

  it('stops the card side counting as income', async () => {
    const { out, into } = await cardPayment();
    const income = () =>
      succeed(
        connection,
        'spending_summary',
        { start_date: '2026-09-01', end_date: '2026-10-31', kind: 'income' },
        summarySchema,
      );
    const spending = () =>
      succeed(
        connection,
        'spending_summary',
        { start_date: '2026-09-01', end_date: '2026-10-31' },
        summarySchema,
      );

    // Unlinked, both halves of one card payment look real.
    expect((await income()).data.total).toBe(500);
    expect((await spending()).data.total).toBe(-500);

    await link({
      pairs: [{ transaction_id: out, counterpart_id: into }],
      dry_run: false,
    });

    expect((await income()).data.total).toBe(0);
    expect((await spending()).data.total).toBe(0);
  });

  describe('when a pair is uncertain', () => {
    async function ambiguous() {
      await add(accounts.main, [
        { date: '2026-09-29', amount: -750 },
        { date: '2026-09-30', amount: -750 },
      ]);
      await add(accounts.visa, [{ date: '2026-10-01', amount: 750 }]);
      return {
        first: await idOf(accounts.main, -750, '2026-09-29'),
        second: await idOf(accounts.main, -750, '2026-09-30'),
        into: await idOf(accounts.visa, 750),
      };
    }

    it('asks first: previews it as needing confirmation and will not apply it', async () => {
      const { second, into } = await ambiguous();

      const { data, text } = await link({
        pairs: [{ transaction_id: second, counterpart_id: into }],
        dry_run: false,
      });

      expect(data).toMatchObject({
        needs_confirmation_count: 1,
        ready_count: 0,
        linked_count: 0,
      });
      expect(data.pairs[0]).toMatchObject({
        status: 'needs_confirmation',
        reasons: ['several_possible_matches'],
        linked: false,
      });
      expect(text).toContain('ASK FIRST');
      expect((await stateOf([second, into])).get(into)?.transfer_id).toBeNull();
    });

    it('links it once the person has agreed, and only the pairs named', async () => {
      const { first, second, into } = await ambiguous();

      const { data } = await link({
        pairs: [{ transaction_id: second, counterpart_id: into }],
        allow_uncertain: true,
        dry_run: false,
      });

      expect(data.linked_count).toBe(1);
      expect(data.warnings.join(' ')).toMatch(/allow_uncertain/);
      const state = await stateOf([first, second, into]);
      expect(state.get(into)?.transfer_id).toBe(second);
      expect(state.get(second)?.transfer_id).toBe(into);
      expect(state.get(first)?.transfer_id).toBeNull();
    });

    it('links the clear pairs of a request and leaves the uncertain ones for later', async () => {
      const { first, into } = await ambiguous();
      await add(accounts.main, [{ date: '2026-09-02', amount: -40 }]);
      await add(accounts.amex, [{ date: '2026-09-03', amount: 40 }]);
      const clearOut = await idOf(accounts.main, -40);
      const clearIn = await idOf(accounts.amex, 40);

      const { data } = await link({
        pairs: [
          { transaction_id: first, counterpart_id: into },
          { transaction_id: clearOut, counterpart_id: clearIn },
        ],
        dry_run: false,
      });

      expect(data).toMatchObject({
        ready_count: 1,
        needs_confirmation_count: 1,
        linked_count: 1,
      });
      const state = await stateOf([first, into, clearOut, clearIn]);
      expect(state.get(clearOut)?.transfer_id).toBe(clearIn);
      expect(state.get(first)?.transfer_id).toBeNull();
    });
  });

  describe('categories', () => {
    it('asks before dropping the category of a transfer between budget accounts, then drops it', async () => {
      await add(accounts.main, [
        { date: '2026-09-30', amount: -300, category: categories.food },
      ]);
      await add(accounts.savings, [{ date: '2026-09-30', amount: 300 }]);
      const out = await idOf(accounts.main, -300);
      const into = await idOf(accounts.savings, 300);

      const preview = await link({
        pairs: [{ transaction_id: out, counterpart_id: into }],
      });
      expect(preview.data.pairs[0]).toMatchObject({
        status: 'needs_confirmation',
        category_cleared: true,
        reasons: ['category_would_be_cleared'],
      });
      expect(preview.text).toMatch(/category will be dropped/);

      await link({
        pairs: [{ transaction_id: out, counterpart_id: into }],
        allow_uncertain: true,
        dry_run: false,
      });
      const state = await stateOf([out, into]);
      expect(state.get(out)?.transfer_id).toBe(into);
      expect(state.get(out)?.['category.name']).toBeNull();
    });

    it('keeps the category of a transfer to a tracking account, without asking', async () => {
      await add(accounts.main, [
        { date: '2026-09-30', amount: -300, category: categories.food },
      ]);
      await add(accounts.brokerage, [{ date: '2026-09-30', amount: 300 }]);
      const out = await idOf(accounts.main, -300);
      const into = await idOf(accounts.brokerage, 300);

      const { data } = await link({
        pairs: [{ transaction_id: out, counterpart_id: into }],
        dry_run: false,
      });

      expect(data.pairs[0]).toMatchObject({
        status: 'ready',
        category_cleared: false,
      });
      const state = await stateOf([out, into]);
      expect(state.get(out)).toMatchObject({
        transfer_id: into,
        'category.name': 'Food',
      });
    });
  });

  describe('creating the other side', () => {
    async function saleProceeds(category?: string) {
      await add(accounts.main, [
        {
          date: '2026-10-05',
          amount: 2000,
          payee: payees.sale,
          category,
        },
      ]);
      return idOf(accounts.main, 2000);
    }

    it('records money from a tracking account that was never imported', async () => {
      const deposit = await saleProceeds();

      const preview = await link({
        pairs: [{ transaction_id: deposit, counterpart_account: 'Brokerage' }],
      });
      expect(preview.data.pairs[0]).toMatchObject({
        status: 'ready',
        mode: 'create_counterpart',
        create_in: 'Brokerage',
        to: null,
      });
      expect(await count(accounts.brokerage)).toBe(0);

      await link({
        pairs: [{ transaction_id: deposit, counterpart_account: 'Brokerage' }],
        dry_run: false,
      });

      // The sale left the brokerage, so the new side is negative.
      expect(await count(accounts.brokerage)).toBe(1);
      const created = await idOf(accounts.brokerage, -2000, '2026-10-05');
      const state = await stateOf([deposit, created]);
      expect(state.get(deposit)).toMatchObject({
        transfer_id: created,
        'payee.name': 'Brokerage',
      });
      expect(state.get(created)).toMatchObject({
        transfer_id: deposit,
        'payee.name': 'Main',
      });
    });

    it('accepts the account by id', async () => {
      const deposit = await saleProceeds();
      const { data } = await link({
        pairs: [
          { transaction_id: deposit, counterpart_account: accounts.brokerage },
        ],
        dry_run: false,
      });
      expect(data.linked_count).toBe(1);
    });

    it('keeps the deposit out of income, however it is categorised', async () => {
      // Filing it under an income category is how the money reaches the
      // envelopes; it still must not look like earnings.
      const deposit = await saleProceeds(categories.drawFund);
      const income = () =>
        succeed(
          connection,
          'spending_summary',
          { start_date: '2026-10-01', end_date: '2026-10-31', kind: 'income' },
          summarySchema,
        );

      expect((await income()).data).toMatchObject({
        total: 2000,
        savings_draws: { count: 0, total: 0 },
      });

      await link({
        pairs: [{ transaction_id: deposit, counterpart_account: 'Brokerage' }],
        dry_run: false,
      });

      const after = await income();
      expect(after.data.total).toBe(0);
      expect(after.data.savings_draws).toEqual({ count: 1, total: 2000 });
      expect(after.text).toMatch(
        /Not counted: 2000.00 moved in from a tracking account/,
      );
      // The category it was filed under is untouched.
      expect((await stateOf([deposit])).get(deposit)?.['category.name']).toBe(
        'Draw Fund',
      );
    });

    it('will not create a duplicate of a side that is already there', async () => {
      const deposit = await saleProceeds();
      await add(accounts.brokerage, [{ date: '2026-10-04', amount: -2000 }]);

      const { data } = await link({
        pairs: [{ transaction_id: deposit, counterpart_account: 'Brokerage' }],
        dry_run: false,
      });

      expect(data.pairs[0]).toMatchObject({
        status: 'needs_confirmation',
        reasons: ['counterpart_already_exists'],
        linked: false,
      });
      expect(await count(accounts.brokerage)).toBe(1);
    });

    it('refuses to make the other side in the same account', async () => {
      const deposit = await saleProceeds();
      const { data } = await link({
        pairs: [{ transaction_id: deposit, counterpart_account: 'Main' }],
      });
      expect(data.pairs[0]).toMatchObject({
        status: 'skipped',
        skipped_reason: expect.stringMatching(/same account/),
      });
    });

    it('names the accounts it knows when one is unknown', async () => {
      const deposit = await saleProceeds();
      expect(
        await fail(connection, 'link_transfers', {
          pairs: [{ transaction_id: deposit, counterpart_account: 'Nowhere' }],
        }),
      ).toMatch(/unknown account "Nowhere".*Brokerage/);
    });
  });

  describe('pairs that cannot be linked', () => {
    it('are skipped with the reason, and do not stop the others', async () => {
      await add(accounts.main, [
        { date: '2026-09-30', amount: -500 },
        { date: '2026-09-20', amount: -60 },
        { date: '2026-09-21', amount: -70 },
      ]);
      await add(accounts.visa, [
        { date: '2026-10-01', amount: 500 },
        { date: '2026-09-20', amount: 61 },
      ]);
      await add(accounts.main, [{ date: '2026-09-22', amount: 70 }]);
      const out = await idOf(accounts.main, -500);
      const into = await idOf(accounts.visa, 500);
      const off = await idOf(accounts.main, -60);
      const wrongAmount = await idOf(accounts.visa, 61);
      const sameAccountOut = await idOf(accounts.main, -70);
      const sameAccountIn = await idOf(accounts.main, 70);

      const { data } = await link({
        pairs: [
          { transaction_id: out, counterpart_id: into },
          { transaction_id: off, counterpart_id: wrongAmount },
          { transaction_id: sameAccountOut, counterpart_id: sameAccountIn },
          { transaction_id: 'no-such-id', counterpart_id: into },
          { transaction_id: out, counterpart_id: into },
          { transaction_id: into },
        ],
        dry_run: false,
      });

      expect(data).toMatchObject({
        requested: 6,
        ready_count: 1,
        skipped_count: 5,
        linked_count: 1,
      });
      expect(data.pairs.map(pair => pair.skipped_reason)).toEqual([
        null,
        expect.stringMatching(/do not cancel/),
        expect.stringMatching(/same account/),
        expect.stringMatching(/not a transaction/),
        expect.stringMatching(/earlier pair/),
        expect.stringMatching(
          /exactly one of counterpart_id and counterpart_account/,
        ),
      ]);
      expect((await stateOf([out])).get(out)?.transfer_id).toBe(into);
    });

    it('include transactions that are transfers already', async () => {
      const { out, into } = await (async () => {
        await add(accounts.main, [{ date: '2026-09-30', amount: -500 }]);
        await add(accounts.visa, [{ date: '2026-10-01', amount: 500 }]);
        return {
          out: await idOf(accounts.main, -500),
          into: await idOf(accounts.visa, 500),
        };
      })();
      await link({
        pairs: [{ transaction_id: out, counterpart_id: into }],
        dry_run: false,
      });

      const again = await link({
        pairs: [{ transaction_id: out, counterpart_id: into }],
        dry_run: false,
      });
      expect(again.data.pairs[0]).toMatchObject({
        status: 'skipped',
        skipped_reason: expect.stringMatching(/already a transfer/),
      });
    });
  });
});
