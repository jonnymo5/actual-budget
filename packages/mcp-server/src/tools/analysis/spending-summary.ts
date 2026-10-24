import { z } from 'zod';

import { loadAnalysisTransactions } from '#actual/analysis-data';
import { assertKnownAccount } from '#actual/transactions';
import { monthOf, monthsBetween, previousPeriod } from '#analysis/dates';
import { summarizeSpending } from '#analysis/spending';
import type { SummaryRow } from '#analysis/spending';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

import {
  comparisonSchema,
  describeComparison,
  includeOffBudget,
} from './shared';

const MAX_MONTHS = 60;

const rowSchema = z.object({
  key: z
    .string()
    .describe(
      'Stable id of the group (category id, payee id, group name or YYYY-MM).',
    ),
  name: z.string(),
  total: z.number().describe('Major units, signed: spending is negative.'),
  transaction_count: z.number(),
  share: z
    .number()
    .nullable()
    .describe(
      'This row as a part of the overall total, 0 to 1; null for kind "all" or a zero total.',
    ),
  comparison: comparisonSchema
    .nullable()
    .describe('Against the previous period; null unless compare_to_previous.'),
});

export const spendingSummary = defineTool({
  name: 'spending_summary',
  title: 'Summarize spending',
  description:
    'Where the money went: totals over a date range, grouped by category, category group, payee or month, biggest first. Amounts are in major currency units (e.g. dollars, not cents) and signed: spending is negative, income is positive. Dates are YYYY-MM-DD, both ends inclusive. Kind "spending" (the default) counts what was spent, with refunds reducing it; "income" counts what was earned; "all" is the net. Transfers between accounts are never counted. Uncategorized transactions appear as "(uncategorized)". With compare_to_previous, every row also shows how it changed against the period just before (the same number of whole months when the range is whole months, otherwise the same number of days). Rows beyond the limit are rolled into one "Other" row, so the answer stays short; use get_transactions to see individual transactions.',
  kind: 'read',
  input: {
    start_date: isoDate.describe('First day to include, YYYY-MM-DD.'),
    end_date: isoDate.describe('Last day to include, YYYY-MM-DD.'),
    group_by: z
      .enum(['category', 'category_group', 'payee', 'month'])
      .default('category')
      .describe(
        'What to total by. "month" lists every month in the range, oldest first.',
      ),
    kind: z
      .enum(['spending', 'income', 'all'])
      .default('spending')
      .describe(
        'What to count: money spent, money earned, or the net of both.',
      ),
    compare_to_previous: z
      .boolean()
      .default(false)
      .describe(
        'Also compare each row with the period just before this one. Not available for group_by month (use spending_trends).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Rows to list before rolling the rest into "Other" (default 20). Ignored for group_by month.',
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
    start_date: z.string(),
    end_date: z.string(),
    group_by: z.string(),
    kind: z.string(),
    total: z.number().describe('Major units, signed.'),
    transaction_count: z.number(),
    previous_period: z
      .object({ start_date: z.string(), end_date: z.string() })
      .nullable()
      .describe(
        'The period compared against; null unless compare_to_previous.',
      ),
    comparison: comparisonSchema
      .nullable()
      .describe('The overall total against the previous period.'),
    rows: z.array(rowSchema),
    other: rowSchema
      .nullable()
      .describe('Everything beyond the limit, added together.'),
  },
  async handler(input, ctx) {
    const period = { start: input.start_date, end: input.end_date };
    if (period.start > period.end) {
      throw toolError(
        `start_date (${period.start}) must not be after end_date (${period.end}).`,
      );
    }
    if (input.group_by === 'month') {
      if (input.compare_to_previous) {
        throw toolError(
          'compare_to_previous does not work with group_by "month", because the months already sit side by side. Use spending_trends for month-over-month changes.',
        );
      }
      if (
        monthsBetween(monthOf(period.start), monthOf(period.end)) >= MAX_MONTHS
      ) {
        throw toolError(
          `group_by "month" lists every month, so the range may span at most ${MAX_MONTHS} months. Use a shorter range.`,
        );
      }
    }
    if (input.account_id) await assertKnownAccount(ctx, input.account_id);

    const previous = input.compare_to_previous ? previousPeriod(period) : null;
    const loaded = await loadAnalysisTransactions(ctx, {
      startDate: previous?.start ?? period.start,
      endDate: period.end,
      accountId: input.account_id,
      includeOffBudget: input.include_off_budget,
    });
    const inPeriod = (start: string, end: string) =>
      loaded.filter(t => t.date >= start && t.date <= end);

    const summary = summarizeSpending({
      transactions: inPeriod(period.start, period.end),
      previous: previous ? inPeriod(previous.start, previous.end) : undefined,
      kind: input.kind,
      groupBy: input.group_by,
      limit: input.limit,
      period,
      money: ctx.amounts,
    });

    const { format } = ctx.amounts;
    const describeRow = (row: SummaryRow) =>
      `${row.name}: ${format(row.total)}${row.share === null ? '' : ` (${(row.share * 100).toFixed(1)}%)`}, ${row.transaction_count} transaction(s)${row.comparison ? `, ${describeComparison(input.kind, row.comparison, format)}` : ''}`;
    const header = `${input.kind} ${period.start} to ${period.end}, by ${input.group_by}: total ${format(summary.total)} over ${summary.transaction_count} transaction(s)${summary.comparison && previous ? ` (${describeComparison(input.kind, summary.comparison, format)}, previous period ${previous.start} to ${previous.end})` : ''}`;
    const lines = [
      header,
      ...summary.rows.map(row => `- ${describeRow(row)}`),
      ...(summary.other ? [`- ${describeRow(summary.other)}`] : []),
    ];

    return {
      data: {
        start_date: period.start,
        end_date: period.end,
        group_by: input.group_by,
        kind: input.kind,
        total: summary.total,
        transaction_count: summary.transaction_count,
        previous_period: previous
          ? { start_date: previous.start, end_date: previous.end }
          : null,
        comparison: summary.comparison,
        rows: summary.rows,
        other: summary.other,
      },
      text: lines.join('\n'),
    };
  },
});
