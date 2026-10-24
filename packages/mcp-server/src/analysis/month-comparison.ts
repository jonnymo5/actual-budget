import type { AmountConverter } from '#actual/amounts';
import type { BudgetMonth } from '#actual/budget-months';

import { roundTo } from './statistics';

export type CategoryVariance = {
  category: string;
  group: string;
  /** Major units. */
  budgeted: number;
  /** Major units, negative: money out. */
  spent: number;
  /** Budgeted plus spent: positive is money left over, negative is overspent. */
  variance: number;
  /** Spent as a percent of the budgeted amount; null when nothing was budgeted. */
  percent_used: number | null;
  /** What the category has left including anything carried over, if known. */
  balance: number | null;
};

export type MonthComparison = {
  month: string;
  totals: {
    budgeted: number;
    spent: number;
    variance: number;
  };
  /** Categories over budget, the worst first. */
  overspent: CategoryVariance[];
  /** Categories with the most left over, the biggest first. */
  underspent: CategoryVariance[];
  overspent_count: number;
  underspent_count: number;
  /** Categories that spent exactly what they budgeted. */
  on_budget_count: number;
};

export function compareBudgetMonth(
  budget: BudgetMonth,
  limit: number,
  money: AmountConverter,
): MonthComparison {
  const categories: CategoryVariance[] = [];
  let budgeted = 0;
  let spent = 0;

  for (const group of budget.groups) {
    if (group.is_income) continue;
    for (const category of group.categories) {
      const planned = money.toMinor(category.budgeted ?? 0);
      const actual = money.toMinor(category.spent ?? 0);
      if (planned === 0 && actual === 0) continue;

      budgeted += planned;
      spent += actual;
      categories.push({
        category: category.name,
        group: group.name,
        budgeted: money.toMajor(planned),
        spent: money.toMajor(actual),
        variance: money.toMajor(planned + actual),
        percent_used: planned === 0 ? null : roundTo(-actual / planned, 1, 100),
        balance: category.balance,
      });
    }
  }

  const byVariance = (a: CategoryVariance, b: CategoryVariance) =>
    a.variance - b.variance || a.category.localeCompare(b.category);
  const over = categories.filter(c => c.variance < 0).sort(byVariance);
  const under = categories
    .filter(c => c.variance > 0)
    .sort((a, b) => -byVariance(a, b) || a.category.localeCompare(b.category));

  return {
    month: budget.month,
    totals: {
      budgeted: money.toMajor(budgeted),
      spent: money.toMajor(spent),
      variance: money.toMajor(budgeted + spent),
    },
    overspent: over.slice(0, limit),
    underspent: under.slice(0, limit),
    overspent_count: over.length,
    underspent_count: under.length,
    on_budget_count: categories.length - over.length - under.length,
  };
}
