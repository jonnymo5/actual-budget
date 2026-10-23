import { z } from 'zod';

import { transactionRowSchema } from '#actual/transactions';
import { connectTestClient } from '#testing/client';
import { seedFixture } from '#testing/fixture';
import type { Fixture } from '#testing/fixture';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import {
  addTransactionsWithoutRules,
  createImportOnlyRule,
  fail,
  succeed,
} from '#testing/tools';

// Every test gets a budget of its own, because many of them change it. It is
// the household in testing/fixture.ts with its three rules:
//   costcoRule      (pre)     payee is Costco               -> category Food
//   bigPurchaseRule (default) amount < -100                 -> add " [large]" to the notes
//   midRangeRule    (post)    amount -50..-10 OR imported payee contains AMZN
//                                                           -> category General
// plus three Costco and no-category Checking transactions on top of the three
// categorized ones (Food 85.50 and 42.25, General 120.00):
//   Costco -30.00 (10-10), -20.00 (10-12), -50.00 (10-14)
let budget: TestBudget;
let fixture: Fixture;
let connection: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  budget = await createTestBudget();
  fixture = await budget.use(async ctx => {
    const seeded = await seedFixture(ctx);
    await addTransactionsWithoutRules(ctx, seeded.accounts.checking, [
      { date: '2026-10-10', amount: -30, payee: seeded.payees.costco },
      { date: '2026-10-12', amount: -20, payee: seeded.payees.costco },
      { date: '2026-10-14', amount: -50, payee: seeded.payees.costco },
    ]);
    return seeded;
  });
  connection = await connectTestClient({ session: budget.session });
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

const matchesSchema = z.object({
  total_count: z.number(),
  total_amount: z.number(),
  by_category: z.array(
    z.object({
      category: z.string().nullable(),
      count: z.number(),
      total_amount: z.number(),
    }),
  ),
  transactions: z.array(transactionRowSchema),
  has_more: z.boolean(),
});
const previewSchema = z.object({
  summary: z.string(),
  matches: matchesSchema,
  warnings: z.array(z.string()),
});
const ruleBodySchema = z.object({
  stage: z.string(),
  match: z.string(),
  summary: z.string(),
  conditions: z.array(
    z.object({ field: z.string(), op: z.string(), value: z.unknown() }),
  ),
  actions: z.array(
    z.object({
      op: z.string(),
      field: z.string().nullable(),
      value: z.unknown(),
    }),
  ),
});
const createSchema = z.object({
  rule_id: z.string().nullable(),
  rule: ruleBodySchema,
  matches: matchesSchema,
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});
const updateSchema = z.object({
  rule_id: z.string(),
  before: ruleBodySchema,
  after: ruleBodySchema,
  matches: matchesSchema.nullable(),
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});
const deleteSchema = z.object({
  rule_id: z.string(),
  rule: ruleBodySchema,
  matches: matchesSchema.nullable(),
  dry_run: z.boolean(),
});
const applySchema = z.object({
  rule: ruleBodySchema,
  matched_count: z.number(),
  change_count: z.number(),
  unchanged_count: z.number(),
  left_alone_count: z.number(),
  skipped: z.array(z.object({ reason: z.string(), count: z.number() })),
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
const rulesSchema = z.object({
  rules: z.array(ruleBodySchema.extend({ id: z.string() })),
});
const pageSchema = z.object({ transactions: z.array(transactionRowSchema) });

const preview = async (args: Record<string, unknown>) =>
  (await succeed(connection, 'preview_rule', args, previewSchema)).data;

async function listRules(includeScheduleRules = false) {
  const { data } = await succeed(
    connection,
    'get_rules',
    { include_schedule_rules: includeScheduleRules },
    rulesSchema,
  );
  return data.rules;
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

const costcoCategories = async () =>
  (await transactionsOf('Costco'))
    .map(row => [row.date, row.category])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('preview_rule', () => {
  it('counts the matches and shows how they are categorized today', async () => {
    const { summary, matches } = await preview({
      conditions: [{ field: 'payee', op: 'is', value: 'Costco' }],
    });

    expect(summary).toBe('payee is Costco');
    expect(matches.total_count).toBe(6);
    expect(matches.total_amount).toBe(-347.75);
    expect(matches.has_more).toBe(false);
    // Most common first.
    expect(matches.by_category).toEqual([
      { category: null, count: 3, total_amount: -100 },
      { category: 'Food', count: 2, total_amount: -127.75 },
      { category: 'General', count: 1, total_amount: -120 },
    ]);
    // Newest first.
    expect(matches.transactions.map(row => row.date)).toEqual([
      '2026-10-14',
      '2026-10-12',
      '2026-10-10',
      '2026-10-02',
      '2026-09-10',
      '2026-09-03',
    ]);
  });

  it('changes nothing', async () => {
    const before = await listRules();
    const costco = await costcoCategories();
    await preview({
      conditions: [{ field: 'payee', op: 'is', value: 'Costco' }],
    });

    expect(await listRules()).toEqual(before);
    expect(await costcoCategories()).toEqual(costco);
  });

  it('understands amounts in major units, spending being negative', async () => {
    // The 120.00 purchase and the 200.00 transfer.
    const big = await preview({
      conditions: [{ field: 'amount', op: 'lt', value: -100 }],
    });
    expect(big.matches.total_count).toBe(2);
    expect(big.matches.total_amount).toBe(-320);
    expect(big.summary).toBe('amount < -100.00');

    // Both ends count (the Old Card's 50.00 payment is exactly on one), and
    // 9.99 is just outside.
    const between = await preview({
      conditions: [
        { field: 'amount', op: 'isbetween', value: { num1: -50, num2: -10 } },
      ],
    });
    expect(between.matches.total_count).toBe(8);
    expect(between.matches.total_amount).toBe(-250.58);
  });

  it('matches text without regard to case, in notes and in the bank description', async () => {
    const notes = await preview({
      conditions: [{ field: 'notes', op: 'contains', value: 'GROCERIES' }],
    });
    expect(notes.matches.total_count).toBe(1);

    const bank = await preview({
      conditions: [{ field: 'imported_payee', op: 'contains', value: 'amzn' }],
    });
    expect(bank.matches.transactions.map(row => row.payee)).toEqual(['Amazon']);

    const pattern = await preview({
      conditions: [{ field: 'notes', op: 'matches', value: '^bulk' }],
    });
    expect(pattern.matches.total_count).toBe(1);

    const isNot = await preview({
      conditions: [
        { field: 'payee', op: 'is', value: 'Costco' },
        { field: 'notes', op: 'doesNotContain', value: 'groceries' },
      ],
    });
    // Rows without any notes count as not containing it.
    expect(isNot.matches.total_count).toBe(5);
  });

  it('combines conditions with all or any', async () => {
    const conditions = [
      { field: 'payee', op: 'is', value: 'Netflix' },
      { field: 'amount', op: 'lt', value: -100 },
    ];
    expect((await preview({ conditions })).matches.total_count).toBe(0);
    const any = await preview({ conditions, match: 'any' });
    // Netflix, the 120.00 purchase and the 200.00 transfer.
    expect(any.matches.total_count).toBe(3);
    expect(any.summary).toBe('payee is Netflix or amount < -100.00');
  });

  it('finds what has no category yet', async () => {
    const { matches } = await preview({
      conditions: [
        { field: 'payee', op: 'is', value: 'Employer' },
        { field: 'category', op: 'is', value: null },
      ],
    });
    expect(matches.total_count).toBe(1);
    expect(matches.total_amount).toBe(2500);

    const categorized = await preview({
      conditions: [
        { field: 'payee', op: 'is', value: 'Costco' },
        { field: 'category', op: 'isNot', value: null },
      ],
    });
    expect(categorized.matches.total_count).toBe(3);
  });

  it('resolves names for payees, categories and accounts, singly or in lists', async () => {
    const payees = await preview({
      conditions: [
        { field: 'payee', op: 'oneOf', value: ['costco', 'Netflix'] },
      ],
    });
    expect(payees.matches.total_count).toBe(7);

    const category = await preview({
      conditions: [{ field: 'category', op: 'is', value: 'Bills' }],
    });
    expect(category.matches.total_count).toBe(1);

    const account = await preview({
      conditions: [{ field: 'account', op: 'is', value: 'Savings' }],
    });
    expect(account.matches.total_count).toBe(2);

    // Ids work as well as names.
    const byId = await preview({
      conditions: [{ field: 'payee', op: 'is', value: fixture.payees.netflix }],
    });
    expect(byId.matches.total_count).toBe(1);
  });

  it('can be limited to dates', async () => {
    const conditions = [{ field: 'payee', op: 'is', value: 'Costco' }];
    const october = await preview({ conditions, start_date: '2026-10-01' });
    expect(october.matches.total_count).toBe(4);

    const window = await preview({
      conditions,
      start_date: '2026-10-01',
      end_date: '2026-10-11',
    });
    expect(window.matches.transactions.map(row => row.date)).toEqual([
      '2026-10-10',
      '2026-10-02',
    ]);

    const byDate = await preview({
      conditions: [
        { field: 'payee', op: 'is', value: 'Costco' },
        { field: 'date', op: 'gte', value: '2026-10-10' },
      ],
    });
    expect(byDate.matches.total_count).toBe(3);
  });

  it('lists only as many matches as asked but counts them all', async () => {
    const { matches } = await preview({
      conditions: [{ field: 'payee', op: 'is', value: 'Costco' }],
      limit: 2,
    });
    expect(matches.transactions).toHaveLength(2);
    expect(matches.total_count).toBe(6);
    expect(matches.has_more).toBe(true);
  });

  it('warns that a percent sign is a wildcard in the preview', async () => {
    const { warnings } = await preview({
      conditions: [{ field: 'notes', op: 'contains', value: '10%' }],
    });
    expect(warnings).toHaveLength(1);
  });

  it('explains what it cannot do', async () => {
    const call = (conditions: unknown[]) =>
      fail(connection, 'preview_rule', { conditions });

    expect(
      await call([{ field: 'payee', op: 'contains', value: 'cost' }]),
    ).toMatch(/payee supports is, isNot, oneOf, notOneOf/);
    expect(
      await call([{ field: 'payee', op: 'is', value: 'Nowhere Inc' }]),
    ).toMatch(/unknown payee "Nowhere Inc".*get_payees/);
    expect(
      await call([{ field: 'category', op: 'is', value: 'Grocerys' }]),
    ).toMatch(/unknown category/);
    expect(
      await call([{ field: 'date', op: 'is', value: '10/02/2026' }]),
    ).toMatch(/YYYY-MM-DD/);
    expect(
      await call([{ field: 'notes', op: 'matches', value: 'Bulk' }]),
    ).toMatch(/lowercase/);
    expect(
      await call([{ field: 'payee_name', op: 'is', value: 'Costco' }]),
    ).toMatch(/Invalid option/);
    await call([]);
  });
});

describe('create_rule', () => {
  const costcoToBills = {
    conditions: [{ field: 'payee', op: 'is', value: 'Netflix' }],
    actions: [{ op: 'set', field: 'category', value: 'Bills' }],
  };

  it('previews the rule and what it would match, and saves nothing', async () => {
    const { data, text } = await succeed(
      connection,
      'create_rule',
      costcoToBills,
      createSchema,
    );

    expect(data.dry_run).toBe(true);
    expect(data.rule_id).toBeNull();
    expect(data.rule).toMatchObject({
      stage: 'default',
      match: 'all',
      summary: 'If payee is Netflix, then set category to Bills',
    });
    expect(data.matches.total_count).toBe(1);
    expect(data.matches.by_category).toEqual([
      { category: 'Bills', count: 1, total_amount: -15.99 },
    ]);
    expect(text).toMatch(
      /^DRY RUN - nothing was changed\.\nWould create rule:/,
    );
    expect(await listRules()).toHaveLength(3);
  });

  it('saves the rule when asked', async () => {
    const syncs = budget.syncCount();
    const { data } = await succeed(
      connection,
      'create_rule',
      { ...costcoToBills, dry_run: false },
      createSchema,
    );

    expect(data.dry_run).toBe(false);
    expect(data.rule_id).toEqual(expect.any(String));
    expect(budget.syncCount()).toBeGreaterThan(syncs);

    const rules = await listRules();
    expect(rules).toHaveLength(4);
    expect(rules.find(rule => rule.id === data.rule_id)).toMatchObject({
      stage: 'default',
      match: 'all',
      summary: 'If payee is Netflix, then set category to Bills',
      conditions: [{ field: 'payee', op: 'is', value: fixture.payees.netflix }],
      actions: [
        { op: 'set', field: 'category', value: fixture.categories.bills },
      ],
    });
  });

  it('categorizes the next imported transaction by itself', async () => {
    const spotify = await budget.use(ctx =>
      ctx.api.createPayee({ name: 'Spotify' }),
    );
    await succeed(
      connection,
      'create_rule',
      {
        conditions: [{ field: 'payee', op: 'is', value: 'Spotify' }],
        actions: [{ op: 'set', field: 'category', value: 'Bills' }],
        dry_run: false,
      },
      createSchema,
    );

    await budget.use(ctx =>
      ctx.api.importTransactions(fixture.accounts.checking, [
        {
          date: '2026-10-16',
          amount: ctx.amounts.toMinor(-9.99),
          account: fixture.accounts.checking,
          payee: spotify,
          imported_id: 'bank-1',
        },
      ]),
    );

    const imported = await transactionsOf('Spotify');
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ category: 'Bills', amount: -9.99 });
  });

  it('stores amounts in the units Actual expects and names the stage and match', async () => {
    const { data } = await succeed(
      connection,
      'create_rule',
      {
        conditions: [
          {
            field: 'amount',
            op: 'isbetween',
            value: { num1: -25.5, num2: -5 },
          },
          { field: 'imported_payee', op: 'contains', value: 'coffee' },
        ],
        actions: [
          { op: 'set', field: 'category', value: 'Food' },
          { op: 'append-notes', value: ' [auto]' },
        ],
        match: 'any',
        stage: 'pre',
        dry_run: false,
      },
      createSchema,
    );

    const created = (await listRules()).find(rule => rule.id === data.rule_id);
    expect(created).toMatchObject({ stage: 'pre', match: 'any' });
    // The rules screen and get_rules show major units; the stored value is in cents.
    expect(created?.conditions[0]).toMatchObject({
      field: 'amount',
      value: { num1: -25.5, num2: -5 },
    });
    expect(data.rule.summary).toBe(
      '[pre] If amount is between -25.50 and -5.00 or imported payee contains coffee, then set category to Food; add " [auto]" to the end of the notes',
    );
  });

  it('warns when a rule with the same conditions exists', async () => {
    const { data } = await succeed(
      connection,
      'create_rule',
      {
        conditions: [{ field: 'payee', op: 'is', value: 'Costco' }],
        actions: [{ op: 'set', field: 'category', value: 'General' }],
      },
      createSchema,
    );

    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain(fixture.rules.costcoRule.id);
    expect(data.warnings[0]).toMatch(/update_rule/);
  });

  it('refuses rules it cannot preview or that make no sense', async () => {
    const create = (args: Record<string, unknown>) =>
      fail(connection, 'create_rule', { dry_run: false, ...args });
    const when = [{ field: 'payee', op: 'is', value: 'Netflix' }];
    const then = [{ op: 'set', field: 'category', value: 'Bills' }];

    expect(
      await create({
        conditions: [{ field: 'payee', op: 'matches', value: 'net' }],
        actions: then,
      }),
    ).toMatch(/conditions\[0\]: matches is not available for payee/);
    expect(
      await create({
        conditions: when,
        actions: [{ op: 'set', field: 'category', value: 'Nonsense' }],
      }),
    ).toMatch(/unknown category "Nonsense"/);
    expect(
      await create({
        conditions: when,
        actions: [{ op: 'set', value: 'Bills' }],
      }),
    ).toMatch(/set needs a field/);
    expect(
      await create({
        conditions: when,
        actions: [{ op: 'delete-transaction', value: 'x' }],
      }),
    ).toMatch(/Invalid option/);
    await create({ conditions: when, actions: [] });
    await create({ conditions: [], actions: then });

    expect(await listRules()).toHaveLength(3);
  });
});

describe('update_rule', () => {
  it('shows the rule before and after, and changes nothing yet', async () => {
    const { data, text } = await succeed(
      connection,
      'update_rule',
      {
        rule_id: fixture.rules.costcoRule.id,
        actions: [{ op: 'set', field: 'category', value: 'General' }],
      },
      updateSchema,
    );

    expect(data.dry_run).toBe(true);
    expect(data.before.summary).toBe(
      '[pre] If payee is Costco, then set category to Food',
    );
    expect(data.after.summary).toBe(
      '[pre] If payee is Costco, then set category to General',
    );
    // Its conditions are untouched, so the matches are the same six.
    expect(data.matches?.total_count).toBe(6);
    expect(text).toMatch(/^DRY RUN/);

    const stored = (await listRules()).find(
      rule => rule.id === fixture.rules.costcoRule.id,
    );
    expect(stored?.summary).toBe(data.before.summary);
  });

  it('changes only the parts it is given', async () => {
    await succeed(
      connection,
      'update_rule',
      {
        rule_id: fixture.rules.costcoRule.id,
        actions: [{ op: 'set', field: 'category', value: 'General' }],
        dry_run: false,
      },
      updateSchema,
    );

    const stored = (await listRules()).find(
      rule => rule.id === fixture.rules.costcoRule.id,
    );
    expect(stored).toMatchObject({
      stage: 'pre',
      match: 'all',
      conditions: [{ field: 'payee', op: 'is', value: fixture.payees.costco }],
      actions: [
        { op: 'set', field: 'category', value: fixture.categories.general },
      ],
    });
  });

  it('can change the conditions, the match, and the stage', async () => {
    const { data } = await succeed(
      connection,
      'update_rule',
      {
        rule_id: fixture.rules.bigPurchaseRule.id,
        conditions: [
          { field: 'amount', op: 'lt', value: -50 },
          { field: 'payee', op: 'is', value: 'Costco' },
        ],
        match: 'any',
        stage: 'post',
        dry_run: false,
      },
      updateSchema,
    );

    // All six Costco rows, plus the 200.00 transfer, which is over 50.00.
    expect(data.matches?.total_count).toBe(7);
    const stored = (await listRules()).find(
      rule => rule.id === fixture.rules.bigPurchaseRule.id,
    );
    expect(stored).toMatchObject({
      stage: 'post',
      match: 'any',
      conditions: [
        { field: 'amount', op: 'lt', value: -50 },
        { field: 'payee', op: 'is', value: fixture.payees.costco },
      ],
      // The action was not mentioned, so it is still there.
      actions: [{ op: 'append-notes', value: ' [large]' }],
    });
  });

  it('keeps "any" and the stage when only the actions change', async () => {
    await succeed(
      connection,
      'update_rule',
      {
        rule_id: fixture.rules.midRangeRule.id,
        actions: [{ op: 'set', field: 'category', value: 'Bills' }],
        dry_run: false,
      },
      updateSchema,
    );

    const stored = (await listRules()).find(
      rule => rule.id === fixture.rules.midRangeRule.id,
    );
    expect(stored).toMatchObject({
      stage: 'post',
      match: 'any',
      actions: [{ field: 'category', value: fixture.categories.bills }],
    });
    expect(stored?.conditions).toHaveLength(2);
  });

  it('can still change a rule whose conditions cannot be previewed', async () => {
    const odd = await budget.use(ctx =>
      createImportOnlyRule(ctx, fixture.categories.food),
    );

    const { data } = await succeed(
      connection,
      'update_rule',
      {
        rule_id: odd.id,
        actions: [{ op: 'set', field: 'category', value: 'Bills' }],
        dry_run: false,
      },
      updateSchema,
    );

    expect(data.matches).toBeNull();
    expect(data.warnings.join(' ')).toMatch(/no preview/);
    const stored = (await listRules()).find(rule => rule.id === odd.id);
    expect(stored?.actions).toMatchObject([
      { value: fixture.categories.bills },
    ]);
  });

  it('refuses unknown rules, schedule rules, and an empty change', async () => {
    const [scheduleRule] = (await listRules(true)).filter(rule =>
      rule.actions.some(action => action.op === 'link-schedule'),
    );
    expect(scheduleRule).toBeDefined();

    expect(
      await fail(connection, 'update_rule', {
        rule_id: scheduleRule.id,
        stage: 'pre',
      }),
    ).toMatch(/behind a schedule/);
    expect(
      await fail(connection, 'update_rule', { rule_id: 'nope', stage: 'pre' }),
    ).toMatch(/unknown rule_id "nope".*get_rules/);
    expect(
      await fail(connection, 'update_rule', {
        rule_id: fixture.rules.costcoRule.id,
      }),
    ).toMatch(/give at least one of/);
  });

  it('warns when another rule already has the same conditions', async () => {
    const { data } = await succeed(
      connection,
      'update_rule',
      {
        rule_id: fixture.rules.bigPurchaseRule.id,
        conditions: [{ field: 'payee', op: 'is', value: 'Costco' }],
      },
      updateSchema,
    );
    expect(data.warnings.join(' ')).toContain(fixture.rules.costcoRule.id);
  });
});

describe('delete_rule', () => {
  it('previews first, and the rule stays', async () => {
    const { data, text } = await succeed(
      connection,
      'delete_rule',
      { rule_id: fixture.rules.costcoRule.id },
      deleteSchema,
    );

    expect(data.dry_run).toBe(true);
    expect(data.rule.summary).toBe(
      '[pre] If payee is Costco, then set category to Food',
    );
    expect(data.matches?.total_count).toBe(6);
    expect(text).toMatch(
      /Call again with dry_run false and confirm true to apply/,
    );
    expect(await listRules()).toHaveLength(3);
  });

  it('needs confirm as well as dry_run false', async () => {
    const message = await fail(connection, 'delete_rule', {
      rule_id: fixture.rules.costcoRule.id,
      dry_run: false,
    });
    expect(message).toMatch(/requires confirm: true/);
    expect(await listRules()).toHaveLength(3);
  });

  it('deletes the rule and leaves the transactions it categorized alone', async () => {
    const before = await costcoCategories();
    const { data } = await succeed(
      connection,
      'delete_rule',
      { rule_id: fixture.rules.costcoRule.id, dry_run: false, confirm: true },
      deleteSchema,
    );

    expect(data.dry_run).toBe(false);
    const remaining = await listRules();
    expect(remaining.map(rule => rule.id)).not.toContain(
      fixture.rules.costcoRule.id,
    );
    expect(remaining).toHaveLength(2);
    expect(await costcoCategories()).toEqual(before);
  });

  it('can delete a rule whose conditions cannot be previewed', async () => {
    const odd = await budget.use(ctx =>
      createImportOnlyRule(ctx, fixture.categories.food),
    );
    const { data } = await succeed(
      connection,
      'delete_rule',
      { rule_id: odd.id, dry_run: false, confirm: true },
      deleteSchema,
    );
    expect(data.matches).toBeNull();
    expect(await listRules()).toHaveLength(3);
  });

  it('refuses unknown rules and the ones that belong to schedules', async () => {
    const [scheduleRule] = (await listRules(true)).filter(rule =>
      rule.actions.some(action => action.op === 'link-schedule'),
    );
    expect(
      await fail(connection, 'delete_rule', {
        rule_id: scheduleRule.id,
        dry_run: false,
        confirm: true,
      }),
    ).toMatch(/behind a schedule/);
    expect(await fail(connection, 'delete_rule', { rule_id: 'nope' })).toMatch(
      /unknown rule_id/,
    );
    expect((await listRules(true)).map(rule => rule.id)).toContain(
      scheduleRule.id,
    );
  });
});

describe('apply_rules_retroactively', () => {
  const costco = () => fixture.rules.costcoRule.id;

  it('previews by default and changes nothing', async () => {
    const before = await costcoCategories();
    const { data, text } = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: costco() },
      applySchema,
    );

    expect(data.dry_run).toBe(true);
    expect(data).toMatchObject({
      matched_count: 6,
      change_count: 3,
      unchanged_count: 0,
      left_alone_count: 3,
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
    expect(text).toMatch(/^DRY RUN - nothing was changed\./);
    expect(await costcoCategories()).toEqual(before);
  });

  it('fills in the missing categories and keeps the ones chosen by hand', async () => {
    const syncs = budget.syncCount();
    const { data } = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: costco(), dry_run: false },
      applySchema,
    );

    expect(data).toMatchObject({ dry_run: false, change_count: 3 });
    expect(budget.syncCount()).toBeGreaterThan(syncs);
    expect(await costcoCategories()).toEqual([
      ['2026-09-03', 'Food'],
      ['2026-09-10', 'Food'],
      ['2026-10-02', 'General'],
      ['2026-10-10', 'Food'],
      ['2026-10-12', 'Food'],
      ['2026-10-14', 'Food'],
    ]);
  });

  it('can replace existing categories when told to', async () => {
    const dry = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: costco(), overwrite: true },
      applySchema,
    );
    expect(dry.data).toMatchObject({
      matched_count: 6,
      change_count: 4,
      unchanged_count: 2,
      left_alone_count: 0,
    });
    expect(
      dry.data.samples.find(sample =>
        sample.changes.some(change => change.from === 'General'),
      )?.changes,
    ).toEqual([{ field: 'category', from: 'General', to: 'Food' }]);

    await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: costco(), overwrite: true, dry_run: false },
      applySchema,
    );
    expect(
      (await costcoCategories()).every(([, category]) => category === 'Food'),
    ).toBe(true);
  });

  it('can be limited to dates', async () => {
    const { data } = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: costco(), start_date: '2026-10-11', dry_run: false },
      applySchema,
    );

    expect(data).toMatchObject({ matched_count: 2, change_count: 2 });
    expect(await costcoCategories()).toEqual(
      expect.arrayContaining([
        ['2026-10-10', null],
        ['2026-10-12', 'Food'],
        ['2026-10-14', 'Food'],
      ]),
    );
  });

  it('adds text to notes once, however many times it runs', async () => {
    const rule = fixture.rules.bigPurchaseRule.id;
    const first = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: rule, dry_run: false },
      applySchema,
    );
    // The 120.00 purchase, and the 200.00 transfer: notes are not tied to a
    // category, so a transfer takes the text too, as it would on import.
    expect(first.data).toMatchObject({ matched_count: 2, change_count: 2 });
    expect(first.data.samples.flatMap(sample => sample.changes)).toEqual(
      expect.arrayContaining([
        {
          field: 'notes',
          from: 'bulk party supplies',
          to: 'bulk party supplies [large]',
        },
      ]),
    );

    const second = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: rule, dry_run: false },
      applySchema,
    );
    expect(second.data).toMatchObject({ change_count: 0, unchanged_count: 2 });
    expect(
      (await transactionsOf('Costco')).find(row => row.amount === -120)?.notes,
    ).toBe('bulk party supplies [large]');
  });

  it('follows "any" and "between" the way the rule does', async () => {
    const rule = fixture.rules.midRangeRule.id;
    // Eight transactions of 10.00 to 50.00, the Old Card's 50.00 payment
    // included, since both ends count (the Amazon one matches both ways).
    const kept = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: rule },
      applySchema,
    );
    expect(kept.data).toMatchObject({
      matched_count: 8,
      change_count: 4,
      left_alone_count: 4,
    });

    const replaced = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: rule, overwrite: true },
      applySchema,
    );
    expect(replaced.data).toMatchObject({
      matched_count: 8,
      change_count: 7,
      unchanged_count: 1,
    });
  });

  it('sets the payee too', async () => {
    const { data: created } = await succeed(
      connection,
      'create_rule',
      {
        conditions: [
          { field: 'imported_payee', op: 'contains', value: 'amzn' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'Costco' }],
        dry_run: false,
      },
      createSchema,
    );
    const ruleId = created.rule_id ?? '';

    const kept = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: ruleId },
      applySchema,
    );
    expect(kept.data).toMatchObject({
      matched_count: 1,
      change_count: 0,
      left_alone_count: 1,
    });

    const { data } = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: ruleId, overwrite: true, dry_run: false },
      applySchema,
    );
    expect(data.samples[0].changes).toEqual([
      { field: 'payee', from: 'Amazon', to: 'Costco' },
    ]);
    // The bank description still says AMZN, but the payee is now Costco.
    expect(await transactionsOf('AMZN')).toMatchObject([
      { payee: 'Costco', amount: -30, date: '2026-10-08' },
    ]);
  });

  it('works for rules that look for transactions without a category', async () => {
    const { data: created } = await succeed(
      connection,
      'create_rule',
      {
        conditions: [
          { field: 'payee', op: 'is', value: 'Employer' },
          { field: 'category', op: 'is', value: null },
        ],
        actions: [{ op: 'set', field: 'category', value: 'General' }],
        dry_run: false,
      },
      createSchema,
    );

    const { data } = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: created.rule_id ?? '', dry_run: false },
      applySchema,
    );
    expect(data).toMatchObject({ matched_count: 1, change_count: 1 });
    expect((await transactionsOf('Employer'))[0].category).toBe('General');
  });

  it('skips what cannot have a category, and says why', async () => {
    const { data: created } = await succeed(
      connection,
      'create_rule',
      {
        conditions: [
          { field: 'account', op: 'oneOf', value: ['Brokerage', 'Savings'] },
          {
            field: 'amount',
            op: 'isbetween',
            value: { num1: -300, num2: 300 },
          },
        ],
        actions: [{ op: 'set', field: 'category', value: 'Food' }],
        dry_run: false,
      },
      createSchema,
    );

    const { data } = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: created.rule_id ?? '', dry_run: false },
      applySchema,
    );
    // The two sides of the 200.00 transfer.
    expect(data).toMatchObject({ matched_count: 2, change_count: 0 });
    expect(data.skipped).toEqual([
      { reason: expect.stringMatching(/transfer between accounts/), count: 2 },
    ]);
  });

  it('refuses a rule whose actions it cannot reproduce exactly', async () => {
    const odd = await budget.use(ctx =>
      ctx.api.createRule({
        stage: 'default',
        conditionsOp: 'and',
        conditions: [
          { field: 'payee', op: 'is', value: fixture.payees.costco },
        ],
        actions: [{ op: 'set', field: 'cleared', value: true }],
      }),
    );

    expect(
      await fail(connection, 'apply_rules_retroactively', {
        rule_id: odd.id,
        dry_run: false,
      }),
    ).toMatch(/cannot preview exactly/);
  });

  it('refuses a rule whose conditions cannot be looked up', async () => {
    const odd = await budget.use(ctx =>
      createImportOnlyRule(ctx, fixture.categories.food),
    );

    expect(
      await fail(connection, 'apply_rules_retroactively', { rule_id: odd.id }),
    ).toMatch(/payee_name.*cannot be looked up/);
  });

  it('refuses unknown rules, schedule rules, and backwards dates', async () => {
    const [scheduleRule] = (await listRules(true)).filter(rule =>
      rule.actions.some(action => action.op === 'link-schedule'),
    );

    expect(
      await fail(connection, 'apply_rules_retroactively', { rule_id: 'nope' }),
    ).toMatch(/unknown rule_id/);
    expect(
      await fail(connection, 'apply_rules_retroactively', {
        rule_id: scheduleRule.id,
      }),
    ).toMatch(/behind a schedule/);
    expect(
      await fail(connection, 'apply_rules_retroactively', {
        rule_id: costco(),
        start_date: '2026-10-02',
        end_date: '2026-10-01',
      }),
    ).toMatch(/must not be after end_date/);
  });
});

describe('the whole workflow', () => {
  it('finds, categorizes, makes a rule, applies it back, and the next import is categorized', async () => {
    const spotify = await budget.use(async ctx => {
      const payee = await ctx.api.createPayee({ name: 'Spotify' });
      await addTransactionsWithoutRules(ctx, fixture.accounts.checking, [
        { date: '2026-10-01', amount: -9.99, payee },
        { date: '2026-10-08', amount: -9.99, payee },
        { date: '2026-10-15', amount: -9.99, payee },
      ]);
      return payee;
    });

    // 1. Find what needs a category.
    const found = await succeed(
      connection,
      'get_uncategorized',
      {},
      z.object({
        groups: z.array(
          z.object({
            payee: z.string().nullable(),
            count: z.number(),
            transactions: z.array(z.object({ id: z.string() })),
          }),
        ),
      }),
    );
    const group = found.data.groups.find(entry => entry.payee === 'Spotify');
    expect(group?.count).toBe(3);

    // 2. Categorize one by hand: preview first, then apply.
    const [first] = group?.transactions ?? [];
    const assignment = {
      assignments: [{ transaction_id: first.id, category: 'Bills' }],
    };
    const categorizeSchema = z.object({ change_count: z.number() });
    expect(
      (
        await succeed(
          connection,
          'categorize_transactions',
          assignment,
          categorizeSchema,
        )
      ).data.change_count,
    ).toBe(1);
    expect(
      (await transactionsOf('Spotify')).filter(row => row.category),
    ).toHaveLength(0);
    await succeed(
      connection,
      'categorize_transactions',
      { ...assignment, dry_run: false },
      categorizeSchema,
    );

    // 3. A rule for the rest. The preview says one of the three is done.
    const { data: rule } = await succeed(
      connection,
      'create_rule',
      {
        conditions: [{ field: 'payee', op: 'is', value: 'Spotify' }],
        actions: [{ op: 'set', field: 'category', value: 'Bills' }],
      },
      createSchema,
    );
    expect(rule.matches.by_category).toEqual([
      { category: null, count: 2, total_amount: -19.98 },
      { category: 'Bills', count: 1, total_amount: -9.99 },
    ]);
    const created = await succeed(
      connection,
      'create_rule',
      {
        conditions: [{ field: 'payee', op: 'is', value: 'Spotify' }],
        actions: [{ op: 'set', field: 'category', value: 'Bills' }],
        dry_run: false,
      },
      createSchema,
    );

    // 4. Apply it to the two that are still open.
    const ruleId = created.data.rule_id ?? '';
    const applied = await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: ruleId },
      applySchema,
    );
    expect(applied.data).toMatchObject({
      matched_count: 3,
      change_count: 2,
      left_alone_count: 1,
    });
    await succeed(
      connection,
      'apply_rules_retroactively',
      { rule_id: ruleId, dry_run: false },
      applySchema,
    );
    expect((await transactionsOf('Spotify')).map(row => row.category)).toEqual([
      'Bills',
      'Bills',
      'Bills',
    ]);

    // 5. Nothing is left over, and the next import is categorized by the rule.
    const left = await succeed(
      connection,
      'get_uncategorized',
      {},
      z.object({ groups: z.array(z.object({ payee: z.string().nullable() })) }),
    );
    expect(left.data.groups.map(entry => entry.payee)).not.toContain('Spotify');

    await budget.use(ctx =>
      ctx.api.importTransactions(fixture.accounts.checking, [
        {
          date: '2026-10-20',
          // A different amount, so Actual does not take it for one of the
          // three charges already in the budget (and outside the -50..-10
          // range the household's own post rule would recategorize).
          amount: ctx.amounts.toMinor(-9.49),
          account: fixture.accounts.checking,
          payee: spotify,
          imported_id: 'bank-spotify-oct',
        },
      ]),
    );
    const all = await transactionsOf('Spotify');
    expect(all).toHaveLength(4);
    expect(all.every(row => row.category === 'Bills')).toBe(true);
  });
});
