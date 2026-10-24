import type { ActualContext } from '#actual/session';

// A year of household history for the analysis tools, built so every pattern
// they look for is present exactly once and the answers can be worked out by
// hand. The clock is frozen at ANALYSIS_TODAY.
//
// The history is dated 2029, ahead of the real clock, on purpose: loot-core
// works out a schedule's next date from the real clock, and schedules that
// start in 2030 keep the same next date whichever day the tests run. The
// analysis only ever reads dates, so it does not care that they are "future".
// (Account balances do count only up to the real today, so tests read the
// starting balance from the budget instead of assuming one.)
export const ANALYSIS_TODAY = '2029-12-20';

const pad = (n: number) => String(n).padStart(2, '0');
const day = (month: number, date: number) => `2029-${pad(month)}-${pad(date)}`;
const months = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);

/** Every second Friday from 2029-01-05 up to the day before ANALYSIS_TODAY. */
export const PAYDAYS: string[] = (() => {
  const dates: string[] = [];
  for (let ms = Date.UTC(2029, 0, 5); ; ms += 14 * 86_400_000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    if (date >= ANALYSIS_TODAY) return dates;
    dates.push(date);
  }
})();

// The monthly series that spending_trends is expected to find, January to
// November 2029, as positive amounts spent.
export const FOOD_BY_MONTH = months(1, 11).map(m => 200 + 30 * (m - 1));
export const GADGETS_BY_MONTH = months(1, 11).map(m => 200 - 15 * (m - 1));
export const HARDWARE_PURCHASES = [38, 42, 40, 41, 39, 43, 40]; // April to October

// A month that exists in every budget whatever the real date, for the tests of
// budgeted versus actual: budget months only reach a year past the real today.
export const PAST_MONTH = '2025-03';

export const EXPECTED = {
  paydayAmount: 2500,
  // PAST_MONTH: food and dining over budget, bills with a little left over,
  // general spending with no budget at all.
  pastBudget: { food: 450, bills: 1600, dining: 40 },
  pastSpent: { food: 500, bills: 1517.99, dining: 50, general: 50 },
  // Groceries a year before the last month the trend tests look at.
  food2028: 400,
};

async function categoryId(ctx: ActualContext, name: string) {
  const category = (await ctx.api.getCategories()).find(c => c.name === name);
  if (!category) throw new Error(`template has no category ${name}`);
  return category.id;
}

export async function seedAnalysisFixture(ctx: ActualContext) {
  const { api, amounts } = ctx;
  const money = amounts.toMinor;

  const [checking] = await api.getAccounts();
  const savings = await api.createAccount({ name: 'Savings' });
  const reserve = await api.createAccount({ name: 'Reserve' });
  const brokerage = await api.createAccount({
    name: 'Brokerage',
    offbudget: true,
  });

  const groups = await api.getCategoryGroups();
  const usual = groups.find(group => group.name === 'Usual Expenses');
  if (!usual) throw new Error('template has no Usual Expenses group');
  const dining = await api.createCategory({
    name: 'Dining',
    group_id: usual.id,
  });
  const food = await categoryId(ctx, 'Food');
  const bills = await categoryId(ctx, 'Bills');
  const general = await categoryId(ctx, 'General');
  const income = await categoryId(ctx, 'Income');
  const startingBalances = await categoryId(ctx, 'Starting Balances');

  type Row = {
    date: string;
    amount: number;
    payee_name: string;
    category?: string;
  };
  const rows: Row[] = [];
  const spend = (
    date: string,
    amount: number,
    payee_name: string,
    category: string,
  ) => rows.push({ date, amount: money(-amount), payee_name, category });

  // Bills: rent every month, a streaming service whose price rose in July,
  // and one that was cancelled after June.
  for (const m of months(1, 12)) spend(day(m, 1), 1500, 'Landlord', bills);
  for (const m of months(1, 6)) spend(day(m, 12), 15.99, 'Netflix', bills);
  for (const m of months(7, 12)) spend(day(m, 12), 17.99, 'Netflix', bills);
  for (const m of months(1, 6)) spend(day(m, 5), 9.99, 'Hulu', bills);

  // A year-ago grocery run for the year-over-year comparison, and the month
  // used for budgeted versus actual.
  spend('2028-11-08', EXPECTED.food2028, 'Costco', food);
  spend(`${PAST_MONTH}-08`, EXPECTED.pastSpent.food, 'Costco', food);
  spend(`${PAST_MONTH}-01`, 1500, 'Landlord', bills);
  spend(`${PAST_MONTH}-12`, 17.99, 'Netflix', bills);
  spend(`${PAST_MONTH}-15`, EXPECTED.pastSpent.dining, 'Corner Cafe', dining);
  spend(`${PAST_MONTH}-10`, EXPECTED.pastSpent.general, 'Gadget Shop', general);

  // Pay.
  for (const date of PAYDAYS) {
    rows.push({
      date,
      amount: money(EXPECTED.paydayAmount),
      payee_name: 'Employer',
      category: income,
    });
  }

  // Groceries grow every month; gadgets shrink; dining holds steady.
  months(1, 11).forEach((m, i) =>
    spend(day(m, 8), FOOD_BY_MONTH[i], 'Costco', food),
  );
  spend(day(12, 8), 530, 'Costco', food);
  months(1, 11).forEach((m, i) =>
    spend(day(m, 10), GADGETS_BY_MONTH[i], 'Gadget Shop', general),
  );
  spend(day(12, 10), 35, 'Gadget Shop', general);
  for (const m of months(1, 12)) spend(day(m, 15), 50, 'Corner Cafe', dining);

  // Seven small hardware purchases, then one that is ten times the usual.
  HARDWARE_PURCHASES.forEach((amount, i) =>
    spend(day(4 + i, 5), amount, 'Hardware Store', general),
  );
  spend(day(12, 10), 400, 'Hardware Store', general);

  // The same charge twice in two days; a large purchase from a new payee; and
  // a charge with no category.
  spend(day(12, 3), 63.17, 'Amazon', general);
  spend(day(12, 4), 63.17, 'Amazon', general);
  spend(day(12, 11), 1800, 'Jewelry Boutique', general);
  rows.push({
    date: day(12, 5),
    amount: money(-9.99),
    payee_name: 'Mystery Vendor',
  });

  await api.addTransactions(checking.id, rows);

  // Opening money for the second account, long before anything above, then a
  // transfer between two on-budget accounts and a fee in the tracking account.
  await api.addTransactions(savings, [
    {
      date: '2020-01-01',
      amount: money(10000),
      payee_name: 'Opening balance',
      category: startingBalances,
    },
  ]);
  const transferToReserve = (await api.getPayees()).find(
    payee => payee.transfer_acct === reserve,
  );
  if (!transferToReserve) throw new Error('no transfer payee for Reserve');
  await api.addTransactions(
    savings,
    [{ date: day(11, 20), amount: money(-400), payee: transferToReserve.id }],
    { runTransfers: true },
  );
  await api.addTransactions(brokerage, [
    { date: day(11, 25), amount: money(-250), payee_name: 'Broker Fee' },
  ]);

  // Actual creates the budget months for existing transactions when it loads
  // a budget, so load it again now that there is data past the template's.
  await api.loadBudget(ctx.budget.id);

  // Budgeted versus actual for PAST_MONTH.
  await api.setBudgetAmount(PAST_MONTH, food, money(EXPECTED.pastBudget.food));
  await api.setBudgetAmount(
    PAST_MONTH,
    bills,
    money(EXPECTED.pastBudget.bills),
  );
  await api.setBudgetAmount(
    PAST_MONTH,
    dining,
    money(EXPECTED.pastBudget.dining),
  );

  // Schedules start in 2030, so their next dates do not depend on the real
  // clock. Rent is tied to the Landlord payee, so its past payments are left
  // out of the cash-flow averages; the gym has no payee.
  const landlord = (await api.getPayees()).find(p => p.name === 'Landlord');
  if (!landlord) throw new Error('fixture has no payee Landlord');
  const monthlyOn = (start: string) => ({
    frequency: 'monthly' as const,
    interval: 1,
    start,
    patterns: [],
    skipWeekend: false,
    weekendSolveMode: 'after' as const,
    endMode: 'never' as const,
  });
  const rentSchedule = await api.createSchedule({
    name: 'Rent',
    posts_transaction: false,
    payee: landlord.id,
    account: checking.id,
    amount: money(-1500),
    amountOp: 'is',
    date: monthlyOn('2030-01-01'),
  });
  const gymSchedule = await api.createSchedule({
    name: 'Gym',
    posts_transaction: false,
    account: checking.id,
    amount: money(-50),
    amountOp: 'isapprox',
    date: monthlyOn('2030-01-15'),
  });

  return {
    accounts: { checking: checking.id, savings, reserve, brokerage },
    categories: { food, bills, general, dining, income },
    schedules: { rentSchedule, gymSchedule },
  };
}

export type AnalysisFixture = Awaited<ReturnType<typeof seedAnalysisFixture>>;
