import type {
  BudgetCategory,
  BudgetGroup,
  BudgetMonth,
} from '#actual/budget-months';
import { usd } from '#testing/transactions';

import { compareBudgetMonth } from './month-comparison';

function category(
  name: string,
  budgeted: number | null,
  spentAmount: number | null,
  balance: number | null = null,
): BudgetCategory {
  return {
    id: name.toLowerCase(),
    name,
    hidden: false,
    carryover: false,
    budgeted,
    spent: spentAmount,
    received: null,
    balance,
  };
}

function group(
  name: string,
  categories: BudgetCategory[],
  isIncome = false,
): BudgetGroup {
  return {
    id: name.toLowerCase(),
    name,
    is_income: isIncome,
    hidden: false,
    budgeted: null,
    spent: null,
    received: null,
    balance: null,
    categories,
  };
}

function month(groups: BudgetGroup[]): BudgetMonth {
  return {
    month: '2029-11',
    budget_type: 'envelope',
    totals: {
      income_available: 0,
      last_month_overspent: 0,
      for_next_month: 0,
      total_budgeted: 0,
      to_budget: 0,
      from_last_month: 0,
      total_income: 0,
      total_spent: 0,
      total_balance: 0,
    },
    groups,
  };
}

const november = month([
  group('Usual Expenses', [
    category('Food', 450, -500, 12),
    category('Bills', 1600, -1517.99),
    category('Dining', 40, -50),
    category('General', 0, -50),
    category('Pets', 100, -100),
    category('Unused', 0, 0),
    category('Gifts', null, null),
  ]),
  group('Income', [category('Salary', 0, 2500)], true),
]);

describe('compareBudgetMonth', () => {
  it('totals budgeted and spent, and the difference', () => {
    const { totals } = compareBudgetMonth(november, 5, usd);

    // 450 + 1600 + 40 + 0 + 100 budgeted; 500 + 1517.99 + 50 + 50 + 100 spent.
    expect(totals).toEqual({
      budgeted: 2190,
      spent: -2217.99,
      variance: -27.99,
    });
  });

  it('lists overspent categories worst first, with what share was used', () => {
    const { overspent, overspent_count } = compareBudgetMonth(november, 5, usd);

    expect(overspent_count).toBe(3);
    expect(overspent).toEqual([
      {
        category: 'Food',
        group: 'Usual Expenses',
        budgeted: 450,
        spent: -500,
        variance: -50,
        percent_used: 111.1,
        balance: 12,
      },
      // No budget at all: overspent by everything, with no percentage to give.
      {
        category: 'General',
        group: 'Usual Expenses',
        budgeted: 0,
        spent: -50,
        variance: -50,
        percent_used: null,
        balance: null,
      },
      {
        category: 'Dining',
        group: 'Usual Expenses',
        budgeted: 40,
        spent: -50,
        variance: -10,
        percent_used: 125,
        balance: null,
      },
    ]);
  });

  it('lists the categories with the most left over', () => {
    const { underspent, underspent_count } = compareBudgetMonth(
      november,
      5,
      usd,
    );

    expect(underspent_count).toBe(1);
    expect(underspent[0]).toMatchObject({
      category: 'Bills',
      variance: 82.01,
      percent_used: 94.9,
    });
  });

  it('counts the categories that landed exactly on budget', () => {
    expect(compareBudgetMonth(november, 5, usd).on_budget_count).toBe(1);
  });

  it('skips income and categories with nothing in them', () => {
    const { overspent, underspent } = compareBudgetMonth(november, 20, usd);
    const names = [...overspent, ...underspent].map(item => item.category);

    expect(names).not.toContain('Salary');
    expect(names).not.toContain('Unused');
    expect(names).not.toContain('Gifts');
  });

  it('cuts each list at the limit but still counts them all', () => {
    const result = compareBudgetMonth(november, 1, usd);

    expect(result.overspent).toHaveLength(1);
    expect(result.overspent_count).toBe(3);
  });

  it('handles a month with no budget lines', () => {
    expect(compareBudgetMonth(month([]), 5, usd)).toEqual({
      month: '2029-11',
      totals: { budgeted: 0, spent: 0, variance: 0 },
      overspent: [],
      underspent: [],
      overspent_count: 0,
      underspent_count: 0,
      on_budget_count: 0,
    });
  });
});
