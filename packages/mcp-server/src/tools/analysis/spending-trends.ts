import { z } from 'zod';

import {
  getFirstTransactionDate,
  loadAnalysisTransactions,
} from '#actual/analysis-data';
import { assertKnownAccount, resolveCategoryIds } from '#actual/transactions';
import {
  addMonths,
  firstDayOf,
  lastDayOf,
  monthOf,
  monthRange,
} from '#analysis/dates';
import { analyzeTrends, TREND_LEAD_MONTHS } from '#analysis/trends';
import type { TrendGroup } from '#analysis/trends';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoMonth } from '#tools/schemas';

import {
  comparisonSchema,
  describeComparison,
  includeOffBudget,
} from './shared';

const trendSchema = z.object({
  direction: z
    .enum(['up', 'down', 'flat'])
    .describe(
      'up: the amounts are getting bigger (more spent, or more earned). down: smaller. flat: no clear trend.',
    ),
  per_month: z
    .number()
    .describe(
      'Straight-line change per month, major units, signed like amounts (so for spending, growth is negative).',
    ),
  percent_per_month: z
    .number()
    .nullable()
    .describe(
      'The same change as a percent of the average size; positive means growing.',
    ),
  r_squared: z
    .number()
    .describe('0 to 1: how well a straight line fits the months.'),
});

const seriesShape = {
  series: z
    .array(z.number())
    .describe('Major units per month, in the order of months.'),
  total: z.number(),
  average: z.number().describe('Average per month.'),
  trend: trendSchema,
  month_over_month: comparisonSchema
    .nullable()
    .describe(
      'The last month against the month before; null with no earlier data.',
    ),
  year_over_year: comparisonSchema
    .nullable()
    .describe(
      'The last month against the same month a year earlier; null with no data then.',
    ),
};

export const spendingTrends = defineTool({
  name: 'spending_trends',
  title: 'Spending trends',
  description:
    'Monthly totals over time with a trend per category (or category group, or payee), to answer "where is my spending going up?". Amounts are in major currency units (e.g. dollars, not cents) and signed: spending is negative, income is positive. Months are YYYY-MM. For each group it gives the monthly series, the average, a straight-line trend (direction up/down/flat, change per month), the last month against the month before and against a year earlier. "up" always means the amounts are getting bigger (more spent, or more earned), whatever their sign. The groups that move the most come first. By default the window is the last 12 complete months, because a half-finished month would look like a drop. Transfers between accounts are never counted.',
  kind: 'read',
  input: {
    months: z
      .number()
      .int()
      .min(2)
      .max(36)
      .default(12)
      .describe(
        'How many months to look at (default 12). Fewer than 3 cannot show a trend.',
      ),
    end_month: isoMonth
      .optional()
      .describe(
        'The last month to include, YYYY-MM. Defaults to the last complete month; pass the current month to include it (marked partial).',
      ),
    kind: z
      .enum(['spending', 'income'])
      .default('spending')
      .describe('Money spent or money earned.'),
    group_by: z
      .enum(['category', 'category_group', 'payee'])
      .default('category')
      .describe('What to give a series for.'),
    category: z
      .string()
      .min(1)
      .optional()
      .describe('Only this category (an id or exact name, case-insensitive).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Groups to list, biggest movers first (default 10). The overall series always covers everything.',
      ),
    account_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only this account (id from list_accounts). Omit for all accounts.',
      ),
    include_off_budget: includeOffBudget,
  },
  output: {
    kind: z.string(),
    group_by: z.string(),
    months: z.array(z.string()).describe('YYYY-MM, oldest first.'),
    last_month_is_partial: z
      .boolean()
      .describe(
        'True when the last month is the current one and still in progress.',
      ),
    overall: z.object(seriesShape).describe('Everything together.'),
    groups: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        ...seriesShape,
      }),
    ),
    omitted_group_count: z.number().describe('Groups left out by the limit.'),
  },
  async handler(input, ctx) {
    const currentMonth = monthOf(ctx.today());
    const endMonth = input.end_month ?? addMonths(currentMonth, -1);
    if (endMonth > currentMonth) {
      throw toolError(
        `end_month ${endMonth} is in the future; the latest month with data is ${currentMonth}.`,
      );
    }
    if (input.account_id) await assertKnownAccount(ctx, input.account_id);
    const categoryIds = input.category
      ? new Set(await resolveCategoryIds(ctx, input.category))
      : null;

    const months = monthRange(
      addMonths(endMonth, -(input.months - 1)),
      endMonth,
    );
    const loaded = await loadAnalysisTransactions(ctx, {
      startDate: firstDayOf(addMonths(months[0], -TREND_LEAD_MONTHS)),
      endDate: lastDayOf(endMonth),
      accountId: input.account_id,
      includeOffBudget: input.include_off_budget,
    });
    const firstDate = await getFirstTransactionDate(ctx);

    const trends = analyzeTrends({
      transactions: categoryIds
        ? loaded.filter(
            t => t.category_id !== null && categoryIds.has(t.category_id),
          )
        : loaded,
      months,
      kind: input.kind,
      groupBy: input.group_by,
      limit: input.limit,
      dataStartMonth: firstDate ? monthOf(firstDate) : null,
      money: ctx.amounts,
    });

    const { format } = ctx.amounts;
    const describe = (name: string, group: Omit<TrendGroup, 'key' | 'name'>) =>
      `${name}: average ${format(group.average)}/month, trend ${group.trend.direction} (${format(group.trend.per_month)}/month${group.trend.percent_per_month === null ? '' : `, ${group.trend.percent_per_month}% of average`})${group.month_over_month ? `; last month ${describeComparison(input.kind, group.month_over_month, format)}` : ''}${group.year_over_year ? `; year over year ${describeComparison(input.kind, group.year_over_year, format)}` : ''}`;
    const partial = endMonth === currentMonth;
    const lines = [
      `${input.kind} by month, ${months[0]} to ${endMonth}${partial ? ' (last month still in progress)' : ''}`,
      describe('Overall', trends.overall),
      `Overall series: ${trends.overall.series.map(format).join(', ')}`,
      ...trends.groups.map(group => `- ${describe(group.name, group)}`),
      ...(trends.omitted_group_count > 0
        ? [
            `(${trends.omitted_group_count} more not shown; raise limit to see them)`,
          ]
        : []),
    ];

    return {
      data: {
        kind: input.kind,
        group_by: input.group_by,
        months: trends.months,
        last_month_is_partial: partial,
        overall: trends.overall,
        groups: trends.groups,
        omitted_group_count: trends.omitted_group_count,
      },
      text: lines.join('\n'),
    };
  },
});
