import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

import {
  getFirstTransactionDate,
  loadAnalysisTransactions,
} from './analysis-data';

let budget: TestBudget;

beforeAll(async () => {
  budget = await createTestBudget();
});

afterAll(async () => {
  await budget.dispose();
});

describe('loadAnalysisTransactions', () => {
  it('reads what the analysis needs, oldest first, with splits inline', async () => {
    const rows = await budget.use(async ctx => {
      const { api, amounts } = ctx;
      const [checking] = await api.getAccounts();
      const groups = await api.getCategoryGroups();
      const everyday = groups.find(group => !group.is_income);
      if (!everyday) throw new Error('template has no expense group');
      const food = await api.createCategory({
        name: 'Test Food',
        group_id: everyday.id,
      });
      const date = (day: number) => `2029-03-${String(day).padStart(2, '0')}`;

      await api.addTransactions(checking.id, [
        {
          date: date(9),
          amount: amounts.toMinor(-30),
          payee_name: 'Later',
          category: food,
        },
        {
          date: date(2),
          amount: amounts.toMinor(-20),
          payee_name: 'Earlier',
          category: food,
        },
        {
          date: date(5),
          amount: amounts.toMinor(-50),
          payee_name: 'Split Shop',
          subtransactions: [
            { amount: amounts.toMinor(-30), category: food },
            { amount: amounts.toMinor(-20) },
          ],
        },
      ]);

      return loadAnalysisTransactions(ctx, {
        startDate: '2029-03-01',
        endDate: '2029-03-31',
        includeOffBudget: false,
      });
    });

    // The two split lines share a date and are told apart only by their random
    // ids, so their order is not fixed: compare them smallest amount first.
    const ordered = [...rows].sort(
      (a, b) => a.date.localeCompare(b.date) || a.amount - b.amount,
    );
    expect(ordered.map(row => [row.date, row.payee, row.amount])).toEqual([
      ['2029-03-02', 'Earlier', -2000],
      ['2029-03-05', 'Split Shop', -3000],
      ['2029-03-05', 'Split Shop', -2000],
      ['2029-03-09', 'Later', -3000],
    ]);
    expect(ordered[0]).toMatchObject({
      account: 'Checking',
      account_off_budget: false,
      category: 'Test Food',
      category_is_income: false,
      is_transfer: false,
    });
    expect(ordered[0].category_group).toBeTruthy();
    // The split line with no category stays uncategorized.
    expect(ordered[2].category_id).toBeNull();
  });

  it('calls a category income when only its group says so', async () => {
    // Categories made through the API or an import are not always flagged on
    // their own row; the income group they sit in is what Actual goes by.
    const rows = await budget.use(async ctx => {
      const { api, amounts } = ctx;
      const [checking] = await api.getAccounts();
      const incomeGroup = (await api.getCategoryGroups()).find(
        group => group.is_income,
      );
      if (!incomeGroup) throw new Error('template has no income group');
      const bonus = await api.createCategory({
        name: 'Test Bonus',
        group_id: incomeGroup.id,
      });
      await api.addTransactions(checking.id, [
        {
          date: '2029-04-01',
          amount: amounts.toMinor(500),
          payee_name: 'Boss',
          category: bonus,
        },
      ]);

      return loadAnalysisTransactions(ctx, {
        startDate: '2029-04-01',
        endDate: '2029-04-30',
        includeOffBudget: false,
      });
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'Test Bonus',
      category_is_income: true,
    });
  });

  it('skips tracking accounts unless asked, and can look at one account', async () => {
    const { withoutTracking, withTracking, onlyTracking } = await budget.use(
      async ctx => {
        const { api, amounts } = ctx;
        const tracking = await api.createAccount({
          name: 'Test Tracking',
          offbudget: true,
        });
        await api.addTransactions(tracking, [
          {
            date: '2029-05-01',
            amount: amounts.toMinor(-75),
            payee_name: 'Fee',
          },
        ]);
        const range = { startDate: '2029-05-01', endDate: '2029-05-31' };

        return {
          withoutTracking: await loadAnalysisTransactions(ctx, {
            ...range,
            includeOffBudget: false,
          }),
          withTracking: await loadAnalysisTransactions(ctx, {
            ...range,
            includeOffBudget: true,
          }),
          onlyTracking: await loadAnalysisTransactions(ctx, {
            ...range,
            accountId: tracking,
            includeOffBudget: true,
          }),
        };
      },
    );

    expect(withoutTracking).toEqual([]);
    expect(withTracking).toHaveLength(1);
    expect(withTracking[0].account_off_budget).toBe(true);
    expect(onlyTracking).toHaveLength(1);
  });

  it('reads everything up to the end date when there is no start date', async () => {
    const rows = await budget.use(ctx =>
      loadAnalysisTransactions(ctx, {
        endDate: '2029-03-31',
        includeOffBudget: false,
      }),
    );

    // The template's own opening transaction comes first.
    expect(rows[0].date).toBe('2019-02-06');
    expect(rows.length).toBeGreaterThan(4);
  });
});

describe('getFirstTransactionDate', () => {
  it('gives the date of the oldest transaction', async () => {
    expect(await budget.use(getFirstTransactionDate)).toBe('2019-02-06');
  });
});

describe('loadAnalysisTransactions and transfers', () => {
  it('tells a transfer from a tracking account apart from one between budget accounts', async () => {
    const rows = await budget.use(async ctx => {
      const { api, amounts } = ctx;
      const brokerage = await api.createAccount({
        name: 'Draw Brokerage',
        offbudget: true,
      });
      const spending = await api.createAccount({ name: 'Draw Spending' });
      const reserve = await api.createAccount({ name: 'Draw Reserve' });
      const transferPayee = async (account: string) => {
        const payee = (await api.getPayees()).find(
          candidate => candidate.transfer_acct === account,
        );
        if (!payee) throw new Error('no transfer payee');
        return payee.id;
      };

      // Entered on the sending side; Actual creates the receiving side.
      await api.addTransactions(
        brokerage,
        [
          {
            date: '2029-06-03',
            amount: amounts.toMinor(-400),
            payee: await transferPayee(spending),
          },
        ],
        { runTransfers: true },
      );
      await api.addTransactions(
        reserve,
        [
          {
            date: '2029-06-04',
            amount: amounts.toMinor(-250),
            payee: await transferPayee(spending),
          },
        ],
        { runTransfers: true },
      );

      return loadAnalysisTransactions(ctx, {
        startDate: '2029-06-01',
        endDate: '2029-06-30',
        accountId: spending,
        includeOffBudget: false,
      });
    });

    expect(rows.map(row => [row.amount, row.is_transfer])).toEqual([
      [40000, true],
      [25000, true],
    ]);
    // 400.00 came from the off-budget brokerage; 250.00 from another budget account.
    expect(rows.map(row => row.transfer_counterpart_off_budget)).toEqual([
      true,
      false,
    ]);
  });
});
