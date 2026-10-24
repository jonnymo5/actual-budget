import type { ActualContext } from '#actual/session';

// A small household budget on top of loot-core's template budget, shared by the
// tool tests. Every figure below is worked out by hand so tests can assert on
// them independently of the code under test.
//
// Checking: the template's 1000.00 starting balance, then the rows seeded below.
//   1000.00 - 85.50 - 42.25 - 15.99 + 2500.00 - 120.00 - 9.99 - 30.00 - 12.34
//   = 3183.93
// Savings: 500.00 opening - 200.00 transferred out = 300.00
// Brokerage (off budget): 2500.00 opening + 200.00 transferred in = 2700.00
// Old Card: closed, 0.00
export const EXPECTED = {
  checking: 3183.93,
  savings: 300,
  brokerage: 2700,
  onBudget: 3483.93,
  offBudget: 2700,
  all: 6183.93,
  transactionCount: 15,
  firstDate: '2019-02-06',
  lastDate: '2026-10-08',
  // Everything dated 2026-09-01..2026-10-31: seven Checking rows plus both
  // sides of the Savings -> Brokerage transfer.
  septOctCount: 9,
  septOctNet: 2196.27,
  // September 2026 budget: Food 400.00 budgeted; Costco spent 85.50 + 42.25.
  septFoodBudgeted: 400,
  septFoodSpent: -127.75,
  septFoodBalance: 272.25,
};

export type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function categoryId(ctx: ActualContext, name: string) {
  const category = (await ctx.api.getCategories()).find(c => c.name === name);
  if (!category) throw new Error(`template has no category ${name}`);
  return category.id;
}

export async function seedFixture(ctx: ActualContext) {
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
  // A hidden category in a visible group, and a hidden group.
  await api.createCategory({
    name: 'Retired Extra',
    group_id: extras,
    hidden: true,
  });
  const archive = await api.createCategoryGroup({
    name: 'Archive',
    hidden: true,
  });
  await api.createCategory({
    name: 'Old Hobby',
    group_id: archive,
    hidden: true,
  });

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
    // Outside the Sept/Oct window the other tests use. Every fixture date must
    // stay in the past: balances only count transactions up to today.
    {
      date: '2026-08-15',
      amount: money(-12.34),
      payee_name: "Trader Joe's",
      category: food,
    },
  ]);

  const payees = new Map(
    (await api.getPayees()).map(payee => [payee.name, payee.id]),
  );
  const payeeId = (name: string) => {
    const id = payees.get(name);
    if (!id) throw new Error(`fixture has no payee ${name}`);
    return id;
  };

  // Actual creates the budget months for existing transactions when it loads a
  // budget, as it does when this one is opened from a sync. The transactions
  // above are newer than the template's months, so load it again.
  await api.loadBudget(ctx.budget.id);

  // The month the budget tests look at.
  await api.setBudgetAmount('2026-09', food, money(400));
  await api.setBudgetAmount('2026-09', bills, money(20));

  const costcoRule = await api.createRule({
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [{ field: 'payee', op: 'is', value: payeeId('Costco') }],
    actions: [{ op: 'set', field: 'category', value: food }],
  });
  const bigPurchaseRule = await api.createRule({
    stage: null,
    conditionsOp: 'and',
    conditions: [{ field: 'amount', op: 'lt', value: money(-100) }],
    actions: [{ op: 'append-notes', value: ' [large]' }],
  });
  const midRangeRule = await api.createRule({
    stage: 'post',
    conditionsOp: 'or',
    conditions: [
      {
        field: 'amount',
        op: 'isbetween',
        value: { num1: money(-50), num2: money(-10) },
      },
      { field: 'imported_payee', op: 'contains', value: 'AMZN' },
    ],
    actions: [{ op: 'set', field: 'category', value: general }],
  });

  // Start dates are far in the future so each schedule's next date is
  // deterministic whatever day the tests run.
  const monthly = {
    frequency: 'monthly' as const,
    interval: 1,
    start: '2030-01-15',
    patterns: [],
    skipWeekend: false,
    weekendSolveMode: 'after' as const,
    endMode: 'never' as const,
  };
  const netflixSchedule = await api.createSchedule({
    name: 'Netflix',
    posts_transaction: false,
    payee: payeeId('Netflix'),
    account: checking.id,
    amount: money(-15.99),
    amountOp: 'is',
    date: monthly,
  });
  const gymSchedule = await api.createSchedule({
    name: 'Gym',
    posts_transaction: true,
    account: checking.id,
    amount: { num1: money(-60), num2: money(-40) },
    amountOp: 'isbetween',
    date: {
      ...monthly,
      frequency: 'weekly',
      interval: 2,
      start: '2030-02-04',
    },
  });
  const taxSchedule = await api.createSchedule({
    name: 'Tax bill',
    posts_transaction: false,
    account: checking.id,
    amount: money(-500),
    amountOp: 'isapprox',
    date: '2030-06-01',
  });
  // Actual marks a schedule completed itself once it has run its course; the
  // public API refuses to set the flag, so use the internal handler it uses.
  const oldSchedule = await api.createSchedule({
    name: 'Old gym',
    posts_transaction: false,
    amount: money(-20),
    amountOp: 'is',
    date: '2030-03-01',
  });
  if (!api.internal) throw new Error('the Actual API is not initialised');
  await api.internal.send('schedule/update', {
    schedule: { id: oldSchedule, completed: true },
  });

  return {
    accounts: {
      checking: checking.id,
      savings,
      brokerage,
      oldCard,
    },
    categories: { food, bills, general, extras, archive },
    payees: { costco: payeeId('Costco'), netflix: payeeId('Netflix') },
    rules: { costcoRule, bigPurchaseRule, midRangeRule },
    schedules: { netflixSchedule, gymSchedule, taxSchedule, oldSchedule },
  };
}
