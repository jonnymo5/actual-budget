import { z } from 'zod';

import { transactionRowSchema } from '#actual/transactions';
import { addDays } from '#analysis/dates';
import { connectTestClient } from '#testing/client';
import { seedFixture } from '#testing/fixture';
import type { Fixture } from '#testing/fixture';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import { ofxEntry, ofxStatement } from '#testing/ofx';
import {
  addTransactionsWithoutRules,
  fail,
  findTransactionIds,
  succeed,
} from '#testing/tools';

// Every test gets a budget of its own, because most of them import. On top of
// the shared household (see testing/fixture.ts) it has an empty account called
// Statement, which the budget's rules apply to like any other:
//   - payee Costco goes to Food (a "pre" rule), unless the amount is between
//     -50 and -10, when the "post" rule moves it to General;
//   - any amount in that range goes to General;
//   - an amount below -100 gets " [large]" added to its notes.
let budget: TestBudget;
let fixture: Fixture & { statement: string };
let connection: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  budget = await createTestBudget({ today: '2026-10-20' });
  fixture = await budget.use(async ctx => {
    const seeded = await seedFixture(ctx);
    const statement = await ctx.api.createAccount({ name: 'Statement' });
    return { ...seeded, statement };
  });
  connection = await connectTestClient({ session: budget.session });
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

// September 2026 on the Statement account. It adds up to 2234.85.
const STATEMENT = [
  {
    date: '2026-09-03',
    amount: -85.5,
    payee_name: 'COSTCO',
    imported_id: 'S-1',
  },
  {
    date: '2026-09-05',
    amount: -22.4,
    payee_name: 'Blue Bottle',
    imported_id: 'S-2',
  },
  {
    date: '2026-09-12',
    amount: -7.25,
    payee_name: 'Corner Shop',
    imported_id: 'S-3',
    notes: 'coffee',
  },
  {
    date: '2026-09-20',
    amount: 2500,
    payee_name: 'Acme Payroll',
    imported_id: 'S-4',
  },
  {
    date: '2026-09-28',
    amount: -150,
    payee_name: 'Landlord',
    imported_id: 'S-5',
  },
];
const STATEMENT_TOTAL = 2234.85;
const WITHOUT_IDS = STATEMENT.map(({ imported_id: _id, ...row }) => row);

const sampleSchema = z.object({
  row: z.number(),
  status: z.enum(['new', 'duplicate', 'updated']),
  date: z.string(),
  amount: z.number(),
  payee_name: z.string().nullable(),
  imported_id: z.string().nullable(),
  matched_transaction: z
    .object({ id: z.string(), date: z.string(), payee: z.string().nullable() })
    .nullable(),
  fills: z.array(z.string()),
});
const importSchema = z.object({
  account: z.object({ id: z.string(), name: z.string() }),
  row_count: z.number(),
  new_count: z.number(),
  duplicate_count: z.number(),
  updated_count: z.number(),
  duplicate_rows: z.array(z.number()),
  updated_rows: z.array(z.number()),
  samples: z.array(sampleSchema),
  applied: z
    .object({
      added_count: z.number(),
      updated_count: z.number(),
      by_category: z.array(
        z.object({
          category: z.string(),
          count: z.number(),
          total_amount: z.number(),
        }),
      ),
      uncategorized: z.object({ count: z.number(), total_amount: z.number() }),
      samples: z.array(
        z.object({
          id: z.string(),
          date: z.string(),
          amount: z.number(),
          payee: z.string().nullable(),
          category: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});
const rowSchema = z.object({
  date: z.string(),
  amount: z.number(),
  payee_name: z.string().nullable(),
  notes: z.string().nullable(),
  imported_id: z.string().nullable(),
});
const parseSchema = z.object({
  count: z.number(),
  rows: z.array(rowSchema),
  first_date: z.string().nullable(),
  last_date: z.string().nullable(),
  total_amount: z.number(),
  skipped: z.array(
    z.object({
      position: z.number(),
      imported_id: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  warnings: z.array(z.string()),
});
const reconcileSchema = z.object({
  account: z.object({ id: z.string(), name: z.string() }),
  statement_date: z.string(),
  actual_balance: z.number(),
  statement_balance: z.number(),
  difference: z.number(),
  balanced: z.boolean(),
  window: z.object({ start_date: z.string(), end_date: z.string() }),
  missing_from_actual: z
    .object({
      count: z.number(),
      total_amount: z.number(),
      rows: z.array(
        z.object({
          row: z.number(),
          date: z.string(),
          amount: z.number(),
          payee_name: z.string().nullable(),
          imported_id: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  difference_after_missing: z.number().nullable(),
  possible_duplicates: z.object({
    group_count: z.number(),
    extra_copies_total: z.number(),
    groups: z.array(
      z.object({
        payee: z.string().nullable(),
        amount: z.number(),
        transactions: z.array(
          z.object({
            id: z.string(),
            date: z.string(),
            notes: z.string().nullable(),
            has_imported_id: z.boolean(),
          }),
        ),
      }),
    ),
  }),
  findings: z.array(z.string()),
});
const pageSchema = z.object({ transactions: z.array(transactionRowSchema) });

type Row = Record<string, unknown>;

function importInto(
  account: string,
  rows: Row[],
  extra: Record<string, unknown> = {},
) {
  return succeed(
    connection,
    'import_transactions',
    { account_id: account, rows, ...extra },
    importSchema,
  );
}

const importRows = (rows: Row[], extra: Record<string, unknown> = {}) =>
  importInto(fixture.statement, rows, extra);

const applyRows = (rows: Row[]) => importRows(rows, { dry_run: false });

async function transactionsOf(account: string) {
  const { data } = await succeed(
    connection,
    'get_transactions',
    {
      account_id: account,
      start_date: '2019-01-01',
      end_date: '2031-12-31',
    },
    pageSchema,
  );
  return data.transactions;
}

function reconcile(args: Record<string, unknown>) {
  return succeed(
    connection,
    'reconcile_account',
    {
      account_id: fixture.statement,
      statement_balance: STATEMENT_TOTAL,
      statement_date: '2026-09-30',
      ...args,
    },
    reconcileSchema,
  );
}

// loot-core's awaited batch write; the API's own deleteTransaction returns
// before its write has finished.
async function removeTransaction(id: string) {
  await budget.use(ctx =>
    ctx.lootCore.send('transactions-batch-update', { deleted: [{ id }] }),
  );
}

describe('import_transactions', () => {
  it('previews by default and changes nothing', async () => {
    const { data, text } = await importRows(WITHOUT_IDS);

    expect(data).toMatchObject({
      dry_run: true,
      account: { id: fixture.statement, name: 'Statement' },
      row_count: 5,
      new_count: 5,
      duplicate_count: 0,
      updated_count: 0,
      duplicate_rows: [],
      updated_rows: [],
      applied: null,
    });
    expect(data.samples.map(sample => [sample.row, sample.status])).toEqual([
      [1, 'new'],
      [2, 'new'],
      [3, 'new'],
      [4, 'new'],
      [5, 'new'],
    ]);
    expect(text).toMatch(
      /^DRY RUN - nothing was changed\.\nWould import 5 row\(s\) into Statement: 5 new, 0 duplicate/,
    );
    expect(text).toMatch(/Rules run on import/);

    expect(await transactionsOf(fixture.statement)).toEqual([]);
  });

  it('adds the rows and reports what the budget rules made of them', async () => {
    const syncsBefore = budget.syncCount();
    const { data, text } = await applyRows(STATEMENT);

    expect(data).toMatchObject({ dry_run: false, new_count: 5 });
    expect(data.applied).toMatchObject({ added_count: 5, updated_count: 0 });
    expect(
      data.applied?.by_category.map(entry => [
        entry.category,
        entry.count,
        entry.total_amount,
      ]),
    ).toEqual([
      ['Food', 1, -85.5],
      ['General', 1, -22.4],
    ]);
    expect(data.applied?.uncategorized).toEqual({
      count: 3,
      total_amount: 2342.75,
    });
    expect(data.applied?.samples).toHaveLength(5);
    expect(text).toMatch(/^Imported 5 row\(s\) into Statement: 5 new/);
    expect(text).toMatch(
      /categorized 2 of the 5 added transaction\(s\); 3 are/,
    );
    expect(budget.syncCount()).toBeGreaterThan(syncsBefore);

    const imported = await transactionsOf(fixture.statement);
    expect(imported).toHaveLength(5);
    const byDate = new Map(imported.map(row => [row.date, row]));
    // The payee is the existing Costco, found by name whatever the case.
    expect(byDate.get('2026-09-03')).toMatchObject({
      payee_id: fixture.payees.costco,
      payee: 'Costco',
      category: 'Food',
      amount: -85.5,
      cleared: true,
    });
    expect(byDate.get('2026-09-05')?.category).toBe('General');
    expect(byDate.get('2026-09-12')).toMatchObject({
      payee: 'Corner Shop',
      category: null,
      notes: 'coffee',
    });
    expect(byDate.get('2026-09-28')?.notes).toBe(' [large]');
  });

  it('files rows under the category given, and lets a rule override it', async () => {
    const { data } = await applyRows([
      {
        date: '2026-09-07',
        amount: -60,
        payee_name: 'Corner Shop',
        category: 'bills',
      },
      // Costco's rule runs after the category is set and wins.
      {
        date: '2026-09-08',
        amount: -90,
        payee_name: 'Costco',
        category: 'Bills',
      },
    ]);

    expect(
      data.applied?.by_category.map(entry => [entry.category, entry.count]),
    ).toEqual([
      ['Bills', 1],
      ['Food', 1],
    ]);
  });

  it('accepts an account by name, and the rows exactly as parse_ofx returns them', async () => {
    const { data } = await importInto('statement', [
      {
        date: '2026-09-03',
        amount: -5,
        payee_name: null,
        notes: null,
        imported_id: null,
        category: null,
      },
    ]);

    expect(data.account.id).toBe(fixture.statement);
    expect(data.new_count).toBe(1);
  });

  it('adds nothing when the same rows are imported again', async () => {
    await applyRows(STATEMENT);

    const preview = await importRows(STATEMENT);
    expect(preview.data).toMatchObject({
      new_count: 0,
      duplicate_count: 5,
      duplicate_rows: [1, 2, 3, 4, 5],
    });
    expect(preview.data.warnings).toEqual([]);

    const { data, text } = await applyRows(STATEMENT);
    expect(data.applied).toMatchObject({ added_count: 0, updated_count: 0 });
    expect(text).toMatch(/0 new, 5 duplicate \(skipped\)/);
    expect(await transactionsOf(fixture.statement)).toHaveLength(5);
  });

  it('recognises rows without an imported_id by amount and date, and says so', async () => {
    await applyRows(WITHOUT_IDS);
    const postedLater = (days: number) =>
      WITHOUT_IDS.map(row => ({ ...row, date: addDays(row.date, days) }));

    // Banks often post a day or two off. Within 7 days it is the same one.
    const near = await importRows(postedLater(2));
    expect(near.data.duplicate_count).toBe(5);
    expect(near.data.warnings).toEqual([
      expect.stringMatching(/5 duplicate row\(s\) have no imported_id/),
    ]);
    expect(near.text).toMatch(/matched on amount and date only/);

    const far = await importRows(postedLater(8));
    expect(far.data).toMatchObject({ new_count: 5, duplicate_count: 0 });
    expect(await transactionsOf(fixture.statement)).toHaveLength(5);
  });

  it('fills in an existing transaction that the row matches, instead of adding one', async () => {
    await budget.use(ctx =>
      addTransactionsWithoutRules(ctx, fixture.statement, [
        { date: '2026-09-12', amount: -7.25 },
      ]),
    );

    const { data, text } = await importRows([STATEMENT[2]]);

    expect(data).toMatchObject({
      new_count: 0,
      duplicate_count: 0,
      updated_count: 1,
      updated_rows: [1],
    });
    expect(data.samples).toEqual([
      expect.objectContaining({
        row: 1,
        status: 'updated',
        matched_transaction: {
          id: expect.any(String),
          date: '2026-09-12',
          payee: null,
        },
        fills: ['imported_id', 'imported_payee', 'payee', 'notes'],
      }),
    ]);
    expect(text).toMatch(/Updated existing transactions:/);

    const applied = await applyRows([STATEMENT[2]]);
    expect(applied.data.applied).toMatchObject({
      added_count: 0,
      updated_count: 1,
    });
    const rows = await transactionsOf(fixture.statement);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payee: 'Corner Shop', notes: 'coffee' });
    expect(await findTransactionIds(budget, { imported_id: 'S-3' })).toEqual([
      rows[0].id,
    ]);
  });

  it('predicts in a dry run exactly what the import then does', async () => {
    await applyRows([STATEMENT[0]]);
    await budget.use(ctx =>
      addTransactionsWithoutRules(ctx, fixture.statement, [
        { date: '2026-09-12', amount: -7.25 },
      ]),
    );
    const rows = STATEMENT.slice(0, 3);
    const before = (await transactionsOf(fixture.statement)).length;

    const preview = await importRows(rows);
    const applied = await applyRows(rows);

    expect(preview.data).toMatchObject({
      new_count: 1,
      duplicate_count: 1,
      updated_count: 1,
      duplicate_rows: [1],
      updated_rows: [3],
    });
    for (const key of [
      'new_count',
      'duplicate_count',
      'updated_count',
      'duplicate_rows',
      'updated_rows',
      'samples',
    ] as const) {
      expect(applied.data[key], key).toEqual(preview.data[key]);
    }
    expect(applied.data.applied).toMatchObject({
      added_count: preview.data.new_count,
      updated_count: preview.data.updated_count,
    });
    expect((await transactionsOf(fixture.statement)).length).toBe(
      before + preview.data.new_count,
    );
  });

  it('warns about rows dated in the future', async () => {
    const { data } = await importRows([
      { date: '2030-01-01', amount: -5, payee_name: 'Later' },
    ]);

    expect(data.warnings).toEqual([
      '1 row(s) are dated after today (2026-10-20); check the dates.',
    ]);
  });

  it('refuses bad input, and imports nothing when it does', async () => {
    const good = STATEMENT[0];
    const refuse = (account: string, rows: Row[]) =>
      fail(connection, 'import_transactions', {
        account_id: account,
        rows,
        dry_run: false,
      });

    expect(await refuse('Nope', [good])).toMatch(/unknown account "Nope"/);
    expect(await refuse(fixture.accounts.oldCard, [good])).toMatch(
      /"Old Card" is closed/,
    );
    expect(
      await refuse(fixture.statement, [
        good,
        { ...STATEMENT[1], category: 'Nonsense' },
      ]),
    ).toMatch(/row 2: unknown category "Nonsense"/);
    expect(
      await refuse(fixture.accounts.brokerage, [{ ...good, category: 'Food' }]),
    ).toMatch(/"Brokerage" is an off-budget account/);
    expect(
      await refuse(fixture.statement, [
        good,
        { ...STATEMENT[1], imported_id: 'S-1' },
      ]),
    ).toMatch(/imported_id "S-1" is on both row 1 and row 2/);
    expect(
      await refuse(fixture.statement, [{ ...good, amount: -1.234 }]),
    ).toMatch(/row 1: the amount -1.234 has more than 2 decimal places/);
    expect(
      await refuse(fixture.statement, [{ ...good, date: '2026-02-30' }]),
    ).toMatch(/real calendar date|YYYY-MM-DD/);
    expect(await refuse(fixture.statement, [])).toMatch(/rows/);

    expect(await transactionsOf(fixture.statement)).toEqual([]);
  });
});

describe('parse_ofx', () => {
  const OFX = ofxStatement(
    STATEMENT.map(row =>
      ofxEntry({
        TRNTYPE: row.amount < 0 ? 'DEBIT' : 'CREDIT',
        DTPOSTED: row.date.replaceAll('-', ''),
        TRNAMT: row.amount.toFixed(2),
        FITID: row.imported_id,
        NAME: row.payee_name,
        ...(row.notes ? { MEMO: row.notes } : {}),
      }),
    ).join('\n'),
  );

  it('turns a statement into rows in major units, ready to import', async () => {
    const { data, text } = await succeed(
      connection,
      'parse_ofx',
      { content: OFX },
      parseSchema,
    );

    expect(data).toMatchObject({
      count: 5,
      first_date: '2026-09-03',
      last_date: '2026-09-28',
      total_amount: STATEMENT_TOTAL,
      skipped: [],
      warnings: [],
    });
    expect(data.rows).toEqual(
      STATEMENT.map(row => ({
        date: row.date,
        amount: row.amount,
        payee_name: row.payee_name,
        notes: 'notes' in row ? row.notes : null,
        imported_id: row.imported_id,
      })),
    );
    expect(text).toMatch(
      /^Read 5 transaction\(s\) dated 2026-09-03 to 2026-09-28/,
    );
    expect(text).toMatch(
      /2026-09-12 \| -7\.25 \| Corner Shop \| coffee \| S-3/,
    );
  });

  it('refuses text that is not a statement', async () => {
    expect(
      await fail(connection, 'parse_ofx', { content: 'Date,Amount\n1,2' }),
    ).toMatch(/no <OFX> element/);
  });

  it('adds nothing when the same statement is imported twice', async () => {
    const parse = () =>
      succeed(connection, 'parse_ofx', { content: OFX }, parseSchema);

    const first = await applyRows((await parse()).data.rows);
    expect(first.data.applied?.added_count).toBe(5);

    const second = await applyRows((await parse()).data.rows);
    expect(second.data).toMatchObject({ new_count: 0, duplicate_count: 5 });
    expect(second.data.applied?.added_count).toBe(0);
    expect(await transactionsOf(fixture.statement)).toHaveLength(5);
  });
});

describe('reconcile_account', () => {
  it('finds nothing wrong with an account that matches its statement', async () => {
    await applyRows(STATEMENT);

    const { data, text } = await reconcile({ rows: STATEMENT });

    expect(data).toMatchObject({
      account: { id: fixture.statement, name: 'Statement' },
      actual_balance: STATEMENT_TOTAL,
      statement_balance: STATEMENT_TOTAL,
      difference: 0,
      balanced: true,
      window: { start_date: '2026-09-03', end_date: '2026-09-30' },
      difference_after_missing: 0,
    });
    expect(data.missing_from_actual).toMatchObject({ count: 0, rows: [] });
    expect(data.possible_duplicates.group_count).toBe(0);
    expect(data.findings).toEqual([
      "Actual's balance on 2026-09-30 matches the statement (2234.85).",
    ]);
    expect(text).toMatch(/difference 0\.00 \(balanced\)/);
  });

  it('catches a transaction that was removed, and shows it explains the gap', async () => {
    await applyRows(STATEMENT);
    const [removed] = await findTransactionIds(budget, { imported_id: 'S-3' });
    await removeTransaction(removed);

    const { data, text } = await reconcile({
      rows: [
        ...STATEMENT,
        { date: '2026-10-05', amount: -9, payee_name: 'Later' },
      ],
    });

    expect(data.balanced).toBe(false);
    expect(data.actual_balance).toBe(2242.1);
    // Statement minus Actual: the removed purchase made Actual too high.
    expect(data.difference).toBe(-7.25);
    expect(data.missing_from_actual).toEqual({
      count: 1,
      total_amount: -7.25,
      rows: [
        {
          row: 3,
          date: '2026-09-12',
          amount: -7.25,
          payee_name: 'Corner Shop',
          imported_id: 'S-3',
        },
      ],
    });
    expect(data.difference_after_missing).toBe(0);
    expect(data.findings).toEqual([
      "The statement says 2234.85 but Actual's balance on 2026-09-30 is 2242.10: Actual is 7.25 too high.",
      'The 1 statement row(s) that are not in Actual add up to exactly the gap (-7.25). Importing them with import_transactions should reconcile the account.',
      '1 row(s) not in Actual are dated after 2026-09-30, so they are not counted in the gap.',
    ]);
    expect(text).toMatch(
      /Statement rows not in Actual:\n {2}row 3 \| 2026-09-12/,
    );

    // Importing the missing row puts the account right.
    await applyRows(STATEMENT);
    expect((await reconcile({ rows: STATEMENT })).data.balanced).toBe(true);
  });

  it('points out a double entry that explains the gap', async () => {
    await applyRows(STATEMENT);
    await budget.use(ctx =>
      addTransactionsWithoutRules(ctx, fixture.statement, [
        { date: '2026-09-04', amount: -85.5, payee: fixture.payees.costco },
      ]),
    );

    const { data, text } = await reconcile({ rows: STATEMENT });

    expect(data.difference).toBe(85.5);
    expect(data.missing_from_actual?.count).toBe(0);
    expect(data.possible_duplicates).toMatchObject({
      group_count: 1,
      extra_copies_total: -85.5,
    });
    expect(data.possible_duplicates.groups[0]).toMatchObject({
      payee: 'Costco',
      amount: -85.5,
    });
    expect(
      data.possible_duplicates.groups[0].transactions.map(t => [
        t.date,
        t.has_imported_id,
      ]),
    ).toEqual([
      ['2026-09-03', true],
      ['2026-09-04', false],
    ]);
    expect(data.findings.at(-1)).toMatch(
      /remaining 85\.50 is exactly the 1 possible double entry listed \(-85\.50 together\)/,
    );
    expect(text).toMatch(
      /Possible double entries:\n {2}Costco -85\.50: 2026-09-03/,
    );
  });

  it('works from the balance alone, and says what rows would add', async () => {
    const { data } = await reconcile({});

    expect(data.difference).toBe(STATEMENT_TOTAL);
    expect(data.missing_from_actual).toBeNull();
    expect(data.difference_after_missing).toBeNull();
    expect(data.window).toEqual({
      start_date: '2026-08-30',
      end_date: '2026-09-30',
    });
    expect(data.findings[1]).toMatch(/No statement rows were given/);
  });

  it('counts transactions up to and including the statement date', async () => {
    await budget.use(ctx =>
      addTransactionsWithoutRules(ctx, fixture.statement, [
        { date: '2026-09-29', amount: -4 },
        { date: '2026-09-30', amount: -10 },
        { date: '2026-10-01', amount: -20 },
      ]),
    );

    const { data } = await reconcile({ statement_balance: -14 });

    expect(data.actual_balance).toBe(-14);
    expect(data.balanced).toBe(true);
  });

  it('notices when a statement balance has the sign Actual would not use', async () => {
    await budget.use(ctx =>
      addTransactionsWithoutRules(ctx, fixture.statement, [
        { date: '2026-09-10', amount: -500 },
      ]),
    );

    const { data } = await reconcile({ statement_balance: 500 });

    expect(data.difference).toBe(1000);
    expect(data.findings[1]).toMatch(
      /exact opposites.*500\.00 owed should be given as -500\.00/,
    );
  });

  it('reconciles a closed account, and refuses impossible requests', async () => {
    const { data } = await reconcile({
      account_id: fixture.accounts.oldCard,
      statement_balance: 0,
    });
    expect(data.balanced).toBe(true);

    expect(
      await fail(connection, 'reconcile_account', {
        account_id: 'Nope',
        statement_balance: 0,
        statement_date: '2026-09-30',
      }),
    ).toMatch(/unknown account "Nope"/);
    expect(
      await fail(connection, 'reconcile_account', {
        account_id: fixture.statement,
        statement_balance: 0,
        statement_date: '2026-09-30',
        statement_start_date: '2026-10-01',
      }),
    ).toMatch(/statement_start_date is after statement_date/);
  });

  it('changes nothing', async () => {
    await applyRows(STATEMENT.slice(0, 2));
    const before = await transactionsOf(fixture.statement);

    await reconcile({ rows: STATEMENT });

    expect(await transactionsOf(fixture.statement)).toEqual(before);
  });
});
