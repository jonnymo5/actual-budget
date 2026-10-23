import { z } from 'zod';

import { getBudgetMonth } from '#actual/budget-months';
import { monthOf } from '#analysis/dates';
import { compareBudgetMonth } from '#analysis/month-comparison';
import { defineTool } from '#tools/registry';
import { isoMonth } from '#tools/schemas';

const varianceSchema = z.object({
  category: z.string(),
  group: z.string(),
  budgeted: z.number().describe('Major units.'),
  spent: z.number().describe('Major units, negative: money out.'),
  variance: z
    .number()
    .describe(
      'Budgeted plus spent: positive is money left over, negative is overspent.',
    ),
  percent_used: z
    .number()
    .nullable()
    .describe(
      'Spent as a percent of the budgeted amount; null when nothing was budgeted.',
    ),
  balance: z
    .number()
    .nullable()
    .describe(
      'What the category has left including anything carried over, if known.',
    ),
});

export const monthComparison = defineTool({
  name: 'month_comparison',
  title: 'Compare budget to actual',
  description:
    'Budgeted versus actual spending for one budget month, with the biggest overspends and underspends. Amounts are in major currency units (e.g. dollars, not cents); spent is negative. The month is YYYY-MM (default: the current month) and must be one that get_budget_months lists. Variance is budgeted plus spent: negative means over budget, positive means money left over. Categories with spending but no budget count as overspent (percent_used is null). Income categories are left out. For the current month the figures are still moving, which the result says. Use get_budget_month for every category.',
  kind: 'read',
  input: {
    month: isoMonth
      .optional()
      .describe('The month, YYYY-MM. Defaults to the current month.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe(
        'Categories to list in each of overspent and underspent (default 5).',
      ),
  },
  output: {
    month: z.string(),
    in_progress: z
      .boolean()
      .describe('True for the current month, whose figures are not final.'),
    totals: z.object({
      budgeted: z.number(),
      spent: z.number().describe('Negative: money out.'),
      variance: z.number().describe('Budgeted plus spent.'),
    }),
    overspent: z
      .array(varianceSchema)
      .describe('Over budget, the worst first.'),
    underspent: z
      .array(varianceSchema)
      .describe('Most money left over, the biggest first.'),
    overspent_count: z
      .number()
      .describe('All categories over budget, before the limit.'),
    underspent_count: z
      .number()
      .describe('All categories with money left, before the limit.'),
    on_budget_count: z
      .number()
      .describe('Categories that spent exactly what was budgeted.'),
  },
  async handler(input, ctx) {
    const today = ctx.today();
    const month = input.month ?? monthOf(today);
    const budget = await getBudgetMonth(ctx, month);
    const comparison = compareBudgetMonth(budget, input.limit, ctx.amounts);
    const inProgress = month === monthOf(today);

    const { format } = ctx.amounts;
    const describe = (item: z.output<typeof varianceSchema>) =>
      `${item.category} (${item.group}): budgeted ${format(item.budgeted)}, spent ${format(item.spent)}, ${item.variance < 0 ? 'over by' : 'left'} ${format(Math.abs(item.variance))}${item.percent_used === null ? ' (no budget)' : ` (${item.percent_used}% used)`}`;
    const lines = [
      `${month}${inProgress ? ' (in progress)' : ''}: budgeted ${format(comparison.totals.budgeted)}, spent ${format(comparison.totals.spent)}, ${comparison.totals.variance < 0 ? 'over by' : 'left'} ${format(Math.abs(comparison.totals.variance))}`,
      `Overspent (${comparison.overspent_count}):`,
      ...comparison.overspent.map(item => `- ${describe(item)}`),
      `Most left over (${comparison.underspent_count}):`,
      ...comparison.underspent.map(item => `- ${describe(item)}`),
    ];

    return {
      data: { ...comparison, in_progress: inProgress },
      text: lines.join('\n'),
    };
  },
});
