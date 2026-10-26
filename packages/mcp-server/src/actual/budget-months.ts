import { z } from 'zod';

import { toolError } from '#errors';

import type { ActualContext } from './session';

export type BudgetAmounts = {
  budgeted: number | null;
  /** Money out this month; negative, like transaction amounts. */
  spent: number | null;
  /** Money in this month (income categories). */
  received: number | null;
  balance: number | null;
};

export type BudgetCategory = BudgetAmounts & {
  id: string;
  name: string;
  hidden: boolean;
  carryover: boolean | null;
};

export type BudgetGroup = BudgetAmounts & {
  id: string;
  name: string;
  is_income: boolean;
  hidden: boolean;
  categories: BudgetCategory[];
};

export type BudgetMonth = {
  month: string;
  budget_type: 'envelope' | 'tracking';
  totals: {
    /** The envelope-only figures are null in a tracking budget, which has no To Budget. */
    income_available: number | null;
    last_month_overspent: number | null;
    for_next_month: number | null;
    total_budgeted: number;
    to_budget: number | null;
    from_last_month: number | null;
    total_income: number;
    total_spent: number;
    total_balance: number;
  };
  groups: BudgetGroup[];
};

// Which of these appear depends on the budget type and on whether the group is
// income, so every amount is optional.
const amount = z.number().nullish();
const rawAmountsShape = {
  budgeted: amount,
  spent: amount,
  received: amount,
  balance: amount,
};
type RawAmounts = z.output<z.ZodObject<typeof rawAmountsShape>>;

const rawMonthSchema = z.object({
  // Actual leaves the first three and the last two out of a tracking budget.
  incomeAvailable: amount,
  lastMonthOverspent: amount,
  forNextMonth: amount,
  totalBudgeted: z.number(),
  toBudget: amount,
  fromLastMonth: amount,
  totalIncome: z.number(),
  totalSpent: z.number(),
  totalBalance: z.number(),
  categoryGroups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_income: z.boolean().nullish(),
      hidden: z.boolean().nullish(),
      ...rawAmountsShape,
      categories: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          hidden: z.boolean().nullish(),
          carryover: z.union([z.boolean(), z.number()]).nullish(),
          ...rawAmountsShape,
        }),
      ),
    }),
  ),
});

export async function listBudgetMonths(ctx: ActualContext): Promise<string[]> {
  return ctx.api.getBudgetMonths();
}

export async function getBudgetMonth(
  ctx: ActualContext,
  month: string,
): Promise<BudgetMonth> {
  const months = await listBudgetMonths(ctx);
  if (!months.includes(month)) {
    const range =
      months.length > 0
        ? ` Budgets exist from ${months[0]} to ${months[months.length - 1]}.`
        : '';
    throw toolError(`No budget exists for month ${month}.${range}`);
  }

  const raw = rawMonthSchema.parse(await ctx.api.getBudgetMonth(month));
  // Actual stores the month's total with its sign flipped (it is subtracted
  // from the money available), unlike the per-category amounts. Add up the
  // expense groups instead so the total agrees with the categories.
  const totalBudgeted = raw.categoryGroups
    .filter(group => !group.is_income)
    .reduce((sum, group) => sum + (group.budgeted ?? 0), 0);
  const prefs = await ctx.api.getPreferences();
  const { toMajor } = ctx.amounts;
  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? null : toMajor(value);
  const amounts = (item: RawAmounts) => ({
    budgeted: money(item.budgeted),
    spent: money(item.spent),
    received: money(item.received),
    balance: money(item.balance),
  });

  return {
    month,
    budget_type: prefs.budgetType === 'tracking' ? 'tracking' : 'envelope',
    totals: {
      income_available: money(raw.incomeAvailable),
      last_month_overspent: money(raw.lastMonthOverspent),
      for_next_month: money(raw.forNextMonth),
      total_budgeted: toMajor(totalBudgeted),
      to_budget: money(raw.toBudget),
      from_last_month: money(raw.fromLastMonth),
      total_income: toMajor(raw.totalIncome),
      total_spent: toMajor(raw.totalSpent),
      total_balance: toMajor(raw.totalBalance),
    },
    groups: raw.categoryGroups.map(group => ({
      id: group.id,
      name: group.name,
      is_income: Boolean(group.is_income),
      hidden: Boolean(group.hidden),
      ...amounts(group),
      categories: group.categories.map(category => ({
        id: category.id,
        name: category.name,
        hidden: Boolean(category.hidden),
        carryover:
          category.carryover === null || category.carryover === undefined
            ? null
            : Boolean(category.carryover),
        ...amounts(category),
      })),
    })),
  };
}
