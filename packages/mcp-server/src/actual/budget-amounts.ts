import { toolError } from '#errors';

import { getBudgetMonth } from './budget-months';
import type { BudgetMonth } from './budget-months';
import type { NamedId } from './lookup';
import type { ActualContext } from './session';

/** One amount to set: a category's budget for one month. */
export type BudgetWish = {
  month: string;
  category: NamedId;
  /** Major units, zero or more. */
  amount: number;
};

export type BudgetChange = {
  month: string;
  category_id: string;
  category: string;
  is_income: boolean;
  /** Major units. */
  from: number;
  to: number;
};

export type BudgetSkip = {
  month: string;
  category: string;
  reason: string;
};

export type MonthTotals = {
  month: string;
  /** Major units: everything budgeted in the expense groups. */
  expense_before: number;
  expense_after: number;
  /** Null unless the budget is a tracking budget, the only kind that budgets income. */
  income_before: number | null;
  income_after: number | null;
};

export type BudgetPlan = {
  budget_type: BudgetMonth['budget_type'];
  changes: BudgetChange[];
  /** Amounts that were already what was asked for. */
  unchanged: number;
  skipped: BudgetSkip[];
  totals: MonthTotals[];
};

type CategoryNow = {
  name: string;
  is_income: boolean;
  /** Minor units. */
  budgeted: number;
};

/**
 * Works out what setting these amounts would do, without doing it. Each month
 * is read once. Amounts are compared in minor units so that 2700.10 and
 * 2700.1 are the same, and nothing drifts through floating point.
 */
export async function planBudgetAmounts(
  ctx: ActualContext,
  wishes: BudgetWish[],
): Promise<BudgetPlan> {
  const { toMinor, toMajor } = ctx.amounts;
  const months = [...new Set(wishes.map(wish => wish.month))].sort();

  const current = new Map<string, Map<string, CategoryNow>>();
  const expenseTotals = new Map<string, number>();
  const incomeTotals = new Map<string, number>();
  let budgetType: BudgetMonth['budget_type'] = 'envelope';
  for (const month of months) {
    const loaded = await getBudgetMonth(ctx, month);
    budgetType = loaded.budget_type;
    const categories = new Map<string, CategoryNow>();
    let expense = 0;
    let income = 0;
    for (const group of loaded.groups) {
      for (const category of group.categories) {
        const budgeted = toMinor(category.budgeted ?? 0);
        categories.set(category.id, {
          name: category.name,
          is_income: group.is_income,
          budgeted,
        });
        if (group.is_income) income += budgeted;
        else expense += budgeted;
      }
    }
    current.set(month, categories);
    expenseTotals.set(month, expense);
    incomeTotals.set(month, income);
  }

  const changes: BudgetChange[] = [];
  const skipped: BudgetSkip[] = [];
  let unchanged = 0;
  const expenseDelta = new Map<string, number>();
  const incomeDelta = new Map<string, number>();

  for (const wish of wishes) {
    const now = current.get(wish.month)?.get(wish.category.id);
    if (!now) {
      skipped.push({
        month: wish.month,
        category: wish.category.name,
        reason: 'the category is not in that month of the budget',
      });
      continue;
    }
    if (now.is_income && budgetType !== 'tracking') {
      skipped.push({
        month: wish.month,
        category: wish.category.name,
        reason:
          'income can only be budgeted in a tracking budget, and this budget is an envelope budget',
      });
      continue;
    }

    const target = toMinor(wish.amount);
    if (target === now.budgeted) {
      unchanged++;
      continue;
    }
    changes.push({
      month: wish.month,
      category_id: wish.category.id,
      category: now.name,
      is_income: now.is_income,
      from: toMajor(now.budgeted),
      to: toMajor(target),
    });
    const deltas = now.is_income ? incomeDelta : expenseDelta;
    deltas.set(
      wish.month,
      (deltas.get(wish.month) ?? 0) + (target - now.budgeted),
    );
  }

  return {
    budget_type: budgetType,
    changes,
    unchanged,
    skipped,
    totals: months.map(month => ({
      month,
      expense_before: toMajor(expenseTotals.get(month) ?? 0),
      expense_after: toMajor(
        (expenseTotals.get(month) ?? 0) + (expenseDelta.get(month) ?? 0),
      ),
      income_before:
        budgetType === 'tracking'
          ? toMajor(incomeTotals.get(month) ?? 0)
          : null,
      income_after:
        budgetType === 'tracking'
          ? toMajor(
              (incomeTotals.get(month) ?? 0) + (incomeDelta.get(month) ?? 0),
            )
          : null,
    })),
  };
}

/** Writes the changes, then reads every month back to make sure they landed. */
export async function applyBudgetChanges(
  ctx: ActualContext,
  changes: BudgetChange[],
): Promise<void> {
  if (changes.length === 0) return;

  for (const change of changes) {
    await ctx.api.setBudgetAmount(
      change.month,
      change.category_id,
      ctx.amounts.toMinor(change.to),
    );
  }

  const months = [...new Set(changes.map(change => change.month))];
  const now = new Map<string, number>();
  for (const month of months) {
    const loaded = await getBudgetMonth(ctx, month);
    for (const group of loaded.groups) {
      for (const category of group.categories) {
        now.set(
          `${month}/${category.id}`,
          ctx.amounts.toMinor(category.budgeted ?? 0),
        );
      }
    }
  }
  const missed = changes.filter(
    change =>
      now.get(`${change.month}/${change.category_id}`) !==
      ctx.amounts.toMinor(change.to),
  );
  if (missed.length > 0) {
    throw toolError(
      `${missed.length} of ${changes.length} amounts did not take (for example ${missed[0].category} in ${missed[0].month}). Check them with get_budget_month before trying again.`,
    );
  }
}
