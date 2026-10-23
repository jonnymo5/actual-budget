import { earned, refunded, spent, usd } from '#testing/transactions';

import { summarizeSpending } from './spending';
import type { SummaryKind } from './spending';
import type { GroupBy } from './transactions';

// September 2029, worked out by hand:
//   Food       -100 -50 +30 (refund)   = -120, three transactions
//   Fun        -20
//   uncategorized -10
//   Salary     +2000
// and a 300 transfer that no summary may count.
const september = [
  spent('2029-09-03', 100, 'Costco', 'Food'),
  spent('2029-09-10', 50, 'Costco', 'Food'),
  spent('2029-09-12', 20, 'Cinema', 'Fun'),
  refunded('2029-09-20', 30, 'Costco', 'Food'),
  spent('2029-09-21', 10, 'Mystery'),
  earned('2029-09-25', 2000, 'Boss'),
  spent('2029-09-26', 300, 'Savings transfer', null, { is_transfer: true }),
];
const period = { start: '2029-09-01', end: '2029-09-30' };

function summarize(
  overrides: {
    kind?: SummaryKind;
    groupBy?: GroupBy;
    limit?: number;
    previous?: typeof september;
    period?: { start: string; end: string };
  } = {},
) {
  return summarizeSpending({
    transactions: september,
    kind: 'spending',
    groupBy: 'category',
    limit: 20,
    period,
    money: usd,
    ...overrides,
  });
}

describe('summarizeSpending', () => {
  it('totals spending by category, biggest first, with refunds netted off', () => {
    const summary = summarize();

    expect(summary.total).toBe(-150);
    expect(summary.transaction_count).toBe(5);
    expect(
      summary.rows.map(row => [row.name, row.total, row.transaction_count]),
    ).toEqual([
      ['Food', -120, 3],
      ['Fun', -20, 1],
      ['(uncategorized)', -10, 1],
    ]);
    expect(summary.rows.map(row => row.share)).toEqual([0.8, 0.133, 0.067]);
    expect(summary.other).toBeNull();
    expect(summary.comparison).toBeNull();
  });

  it('totals income, or the net of everything', () => {
    const income = summarize({ kind: 'income' });
    expect(income.total).toBe(2000);
    expect(income.rows.map(row => row.name)).toEqual(['Salary']);

    const net = summarize({ kind: 'all' });
    expect(net.total).toBe(1850);
    expect(net.rows.map(row => row.share)).toEqual([null, null, null, null]);
  });

  it('never counts a transfer', () => {
    const everything = summarize({ kind: 'all' });
    expect(everything.transaction_count).toBe(6);
    expect(everything.rows.map(row => row.name)).not.toContain(
      'Savings transfer',
    );
  });

  it('groups by payee, category group and month', () => {
    expect(
      summarize({ groupBy: 'payee' }).rows.map(row => [row.name, row.total]),
    ).toEqual([
      ['Costco', -120],
      ['Cinema', -20],
      ['Mystery', -10],
    ]);
    expect(
      summarize({ groupBy: 'category_group' }).rows.map(row => [
        row.name,
        row.total,
      ]),
    ).toEqual([
      ['Everyday', -140],
      ['(uncategorized)', -10],
    ]);
    expect(
      summarize({ groupBy: 'month' }).rows.map(row => [row.name, row.total]),
    ).toEqual([['2029-09', -150]]);
  });

  it('lists every month of the period oldest first, including empty ones', () => {
    const summary = summarize({
      groupBy: 'month',
      period: { start: '2029-08-01', end: '2029-10-31' },
    });
    expect(summary.rows.map(row => [row.name, row.total])).toEqual([
      ['2029-08', 0],
      ['2029-09', -150],
      ['2029-10', 0],
    ]);
  });

  it('rolls the rows beyond the limit into one Other row', () => {
    const summary = summarize({ limit: 1 });

    expect(summary.rows.map(row => row.name)).toEqual(['Food']);
    expect(summary.other).toMatchObject({
      name: 'Other (2 more)',
      total: -30,
      transaction_count: 2,
      share: 0.2,
    });
    // Nothing is lost: the rows and Other add up to the total.
    expect(summary.rows[0].total + (summary.other?.total ?? 0)).toBe(
      summary.total,
    );
  });

  it('does not cut months off with the limit', () => {
    const summary = summarize({
      groupBy: 'month',
      limit: 1,
      period: { start: '2029-08-01', end: '2029-10-31' },
    });
    expect(summary.rows).toHaveLength(3);
    expect(summary.other).toBeNull();
  });
});

describe('summarizeSpending compared with the period before', () => {
  const august = [
    spent('2029-08-05', 60, 'Costco', 'Food'),
    spent('2029-08-09', 40, 'Gym', 'Health'),
    earned('2029-08-25', 1500, 'Boss'),
  ];

  it('says how each row moved, as a share of the earlier amount', () => {
    const summary = summarize({ previous: august });

    expect(summary.comparison).toEqual({
      previous_total: -100,
      change: -50,
      percent_change: 50,
      direction: 'higher',
    });
    const byName = Object.fromEntries(
      summary.rows.map(row => [row.name, row.comparison]),
    );
    expect(byName.Food).toEqual({
      previous_total: -60,
      change: -60,
      percent_change: 100,
      direction: 'higher',
    });
    // New this period: no earlier amount to take a percentage of.
    expect(byName.Fun).toEqual({
      previous_total: 0,
      change: -20,
      percent_change: null,
      direction: 'higher',
    });
  });

  it('keeps spending that stopped, as a row that fell to zero', () => {
    const summary = summarize({ previous: august });
    const health = summary.rows.find(row => row.name === 'Health');

    expect(health).toMatchObject({ total: 0, transaction_count: 0 });
    expect(health?.comparison).toEqual({
      previous_total: -40,
      change: 40,
      percent_change: -100,
      direction: 'lower',
    });
    // It sorts after everything that still has spending.
    expect(summary.rows[summary.rows.length - 1].name).toBe('Health');
  });

  it('measures income growth as positive', () => {
    const summary = summarize({ kind: 'income', previous: august });
    expect(summary.comparison).toEqual({
      previous_total: 1500,
      change: 500,
      percent_change: 33.3,
      direction: 'higher',
    });
  });

  it('compares the rolled-up rows too', () => {
    const summary = summarize({ limit: 3, previous: august });
    expect(summary.other?.name).toBe('Other (1 more)');
    expect(summary.other?.comparison).toMatchObject({
      previous_total: -40,
      direction: 'lower',
    });
  });

  it('reports no change when the period matches', () => {
    const summary = summarize({ previous: september });
    expect(summary.comparison).toEqual({
      previous_total: -150,
      change: 0,
      percent_change: 0,
      direction: 'unchanged',
    });
  });
});
