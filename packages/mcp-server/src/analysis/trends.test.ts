import { earned, monthly, repeat, spent, usd } from '#testing/transactions';

import { monthRange } from './dates';
import type { AnalysisTransaction } from './transactions';
import { analyzeTrends } from './trends';

// March to November 2029. Food grows by exactly 30 a month, gadgets shrink by
// 15, dining holds at 50, so the straight-line trends can be read off.
const months = monthRange('2029-03', '2029-11');
const food = [
  spent('2028-11-08', 400, 'Costco', 'Food'),
  ...repeat(
    monthly('2029-01', 8, 11),
    [200, 230, 260, 290, 320, 350, 380, 410, 440, 470, 500],
    'Costco',
    'Food',
  ),
];
const gadgets = repeat(
  monthly('2029-01', 10, 11),
  [200, 185, 170, 155, 140, 125, 110, 95, 80, 65, 50],
  'Gadget Shop',
  'General',
);
const dining = repeat(monthly('2029-01', 15, 11), 50, 'Cafe', 'Dining');
const transactions = [...food, ...gadgets, ...dining];

function trends(overrides: Partial<Parameters<typeof analyzeTrends>[0]> = {}) {
  return analyzeTrends({
    transactions,
    months,
    kind: 'spending',
    groupBy: 'category',
    limit: 10,
    dataStartMonth: '2019-02',
    money: usd,
    ...overrides,
  });
}

describe('analyzeTrends', () => {
  it('finds a steadily growing category', () => {
    const food = trends().groups.find(group => group.name === 'Food');

    expect(food?.series).toEqual([
      -260, -290, -320, -350, -380, -410, -440, -470, -500,
    ]);
    expect(food?.average).toBe(-380);
    expect(food?.trend).toEqual({
      direction: 'up',
      per_month: -30,
      percent_per_month: 7.9,
      r_squared: 1,
    });
  });

  it('finds a shrinking category, with a per-month change that is positive money', () => {
    const gadgets = trends().groups.find(group => group.name === 'General');

    expect(gadgets?.trend).toMatchObject({ direction: 'down', per_month: 15 });
    expect(gadgets?.trend.percent_per_month).toBeLessThan(0);
  });

  it('calls a constant category flat', () => {
    const dining = trends().groups.find(group => group.name === 'Dining');

    expect(dining?.trend).toEqual({
      direction: 'flat',
      per_month: 0,
      percent_per_month: 0,
      r_squared: 0,
    });
  });

  it('puts the biggest movers first, whichever way they move', () => {
    expect(trends().groups.map(group => group.name)).toEqual([
      'Food',
      'General',
      'Dining',
    ]);
  });

  it('compares the last month with the one before and with a year earlier', () => {
    const food = trends().groups.find(group => group.name === 'Food');

    expect(food?.month_over_month).toEqual({
      previous_total: -470,
      change: -30,
      percent_change: 6.4,
      direction: 'higher',
    });
    expect(food?.year_over_year).toEqual({
      previous_total: -400,
      change: -100,
      percent_change: 25,
      direction: 'higher',
    });
  });

  it('has no year-over-year figure when the budget did not exist a year earlier', () => {
    const food = trends({ dataStartMonth: '2029-01' }).groups.find(
      group => group.name === 'Food',
    );

    expect(food?.year_over_year).toBeNull();
    expect(food?.month_over_month).not.toBeNull();
  });

  it('adds up everything for the overall series', () => {
    const overall = trends().overall;

    // March: 260 + 170 + 50, November: 500 + 50 + 50.
    expect(overall.series[0]).toBe(-480);
    expect(overall.series[8]).toBe(-600);
    expect(overall.total).toBe(
      overall.series.reduce((sum, value) => sum + value, 0),
    );
  });

  it('cuts the list at the limit and says how many were left out', () => {
    const result = trends({ limit: 1 });

    expect(result.groups.map(group => group.name)).toEqual(['Food']);
    expect(result.omitted_group_count).toBe(2);
  });

  it('groups by payee', () => {
    const names = trends({ groupBy: 'payee' }).groups.map(group => group.name);
    expect(names).toEqual(['Costco', 'Gadget Shop', 'Cafe']);
  });

  it('trends income upward when earnings grow', () => {
    const dates = monthly('2029-03', 1, 9);
    const pay = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800].map(
      (dollars, index) => earned(dates[index], dollars, 'Boss'),
    );
    const income = trends({ transactions: pay, kind: 'income' }).groups[0];

    expect(income.trend).toMatchObject({ direction: 'up', per_month: 100 });
  });

  it('ignores the other kind of money', () => {
    const result = trends({ kind: 'income' });
    expect(result.groups).toEqual([]);
    expect(result.overall.total).toBe(0);
  });

  it('does not call a trend from too few months', () => {
    const result = trends({ months: monthRange('2029-10', '2029-11') });
    const food = result.groups.find(group => group.name === 'Food');

    expect(food?.trend.direction).toBe('flat');
  });

  it('does not call a trend from a series that only zigzags', () => {
    const zigzag: AnalysisTransaction[] = monthly('2029-03', 8, 9).map(
      (date, index) => spent(date, index % 2 === 0 ? 100 : 300, 'Shop', 'Fun'),
    );
    const result = trends({ transactions: zigzag });

    expect(result.groups[0].trend.direction).toBe('flat');
  });

  it('does not call a trend from a small drift', () => {
    const drift = monthly('2029-03', 8, 9).map((date, index) =>
      spent(date, 1000 + index * 10, 'Landlord', 'Rent'),
    );
    const result = trends({ transactions: drift });

    // Perfectly straight, but only 8% over the window.
    expect(result.groups[0].trend).toMatchObject({
      direction: 'flat',
      r_squared: 1,
    });
  });
});
