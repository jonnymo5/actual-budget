import { z } from 'zod';

import { getBudgetMonth as loadBudgetMonth } from '#actual/budget-months';
import type { BudgetAmounts } from '#actual/budget-months';
import { defineTool } from '#tools/registry';
import { isoMonth } from '#tools/schemas';

const amountsShape = {
  budgeted: z.number().nullable().describe('Amount budgeted this month.'),
  spent: z
    .number()
    .nullable()
    .describe('Money out this month. Negative, like transaction amounts.'),
  received: z
    .number()
    .nullable()
    .describe('Money in this month; set for income categories.'),
  balance: z
    .number()
    .nullable()
    .describe(
      'What is left: budgeted plus any carried-over balance plus spent.',
    ),
};

export const getBudgetMonth = defineTool({
  name: 'get_budget_month',
  title: 'Get a budget month',
  description:
    'Show one month of the budget: for every category group and category, how much was budgeted, how much was spent (negative: money out), how much was received (income), and the balance left. Also the month totals, including what is still to be budgeted. Amounts are in major currency units (e.g. dollars, not cents). The month is YYYY-MM and must be one that get_budget_months lists. Envelope budgets report budgeted/spent/balance; tracking budgets report received for income as well.',
  kind: 'read',
  input: {
    month: isoMonth.describe('The month, YYYY-MM.'),
  },
  output: {
    month: z.string(),
    budget_type: z.enum(['envelope', 'tracking']),
    totals: z.object({
      income_available: z.number(),
      last_month_overspent: z.number(),
      for_next_month: z.number().describe('Held back for next month.'),
      total_budgeted: z.number(),
      to_budget: z.number().describe('Still unassigned (envelope budgets).'),
      from_last_month: z.number(),
      total_income: z.number(),
      total_spent: z.number().describe('Negative: money out.'),
      total_balance: z.number(),
    }),
    groups: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        is_income: z.boolean(),
        hidden: z.boolean(),
        ...amountsShape,
        categories: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            hidden: z.boolean(),
            carryover: z
              .boolean()
              .nullable()
              .describe('Whether a leftover balance rolls into next month.'),
            ...amountsShape,
          }),
        ),
      }),
    ),
  },
  async handler({ month }, ctx) {
    const budget = await loadBudgetMonth(ctx, month);

    const { format } = ctx.amounts;
    const show = (value: number | null) =>
      value === null ? '-' : format(value);
    const describe = (amounts: BudgetAmounts) =>
      [
        `budgeted ${show(amounts.budgeted)}`,
        amounts.spent !== null ? `spent ${show(amounts.spent)}` : null,
        amounts.received !== null ? `received ${show(amounts.received)}` : null,
        `balance ${show(amounts.balance)}`,
      ]
        .filter(Boolean)
        .join(', ');

    const { totals } = budget;
    const lines = [
      `Budget for ${budget.month} (${budget.budget_type}): budgeted ${format(totals.total_budgeted)}, spent ${format(totals.total_spent)}, income ${format(totals.total_income)}, to budget ${format(totals.to_budget)}`,
      ...budget.groups.flatMap(group => [
        `${group.name}${group.is_income ? ' (income)' : ''}: ${describe(group)}`,
        ...group.categories.map(
          category => `  - ${category.name}: ${describe(category)}`,
        ),
      ]),
    ];

    return { data: budget, text: lines.join('\n') };
  },
});
