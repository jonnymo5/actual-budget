import { z } from 'zod';

import {
  getFirstTransactionDate,
  loadAnalysisTransactions,
} from '#actual/analysis-data';
import { assertKnownAccount } from '#actual/transactions';
import { firstDayOf, monthOf } from '#analysis/dates';
import { findOutliers } from '#analysis/outliers';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

import { includeOffBudget, transactionBriefSchema } from './shared';

const outlierSchema = z.object({
  type: z
    .enum(['unusual_amount', 'new_payee', 'possible_duplicate'])
    .describe(
      'unusual_amount: far above what this payee or category usually costs. new_payee: a large first purchase from a payee never seen before. possible_duplicate: the same payee charged the same amount to the same account again within a few days.',
    ),
  transaction: transactionBriefSchema,
  reason: z.string().describe('Why it was flagged, in plain language.'),
  related_transaction: transactionBriefSchema
    .nullable()
    .describe('For a possible duplicate: the earlier transaction it repeats.'),
  days_apart: z
    .number()
    .nullable()
    .describe('For a possible duplicate: days between the two.'),
  baseline: z
    .enum(['payee', 'category'])
    .nullable()
    .describe(
      'For an unusual amount: whether the payee or the category was the yardstick.',
    ),
  baseline_size: z
    .number()
    .nullable()
    .describe('How many earlier purchases the yardstick came from.'),
  typical_amount: z
    .number()
    .nullable()
    .describe(
      'For an unusual amount: the median earlier amount, major units, signed.',
    ),
  times_typical: z
    .number()
    .nullable()
    .describe('This amount divided by the typical one.'),
  z_score: z
    .number()
    .nullable()
    .describe(
      'Standard deviations above the earlier mean; null when earlier amounts never varied.',
    ),
});

export const findOutliersTool = defineTool({
  name: 'find_outliers',
  title: 'Find unusual transactions',
  description:
    'Look for weird charges in a date window (by default this month so far): purchases far larger than usual for their payee or category, large first purchases from a payee never seen before, and possible duplicates (the same payee charging the same amount to the same account again within a few days). Amounts are in major currency units (e.g. dollars, not cents) and signed: spending is negative. Dates are YYYY-MM-DD. Each finding says why it was flagged. Findings are listed largest amount first, capped by limit. "Unusual" is judged against the payee\'s own earlier purchases (or its category\'s, if the payee is new to the budget) with quartile fences, so a single earlier blow-out does not hide the next one. Transfers are ignored. This is a screen for human review, not proof of a problem: use get_transactions to look closer.',
  kind: 'read',
  input: {
    start_date: isoDate
      .optional()
      .describe(
        'First day of the window to inspect, YYYY-MM-DD. Defaults to the first of this month.',
      ),
    end_date: isoDate
      .optional()
      .describe('Last day of the window, YYYY-MM-DD. Defaults to today.'),
    history_months: z
      .number()
      .int()
      .min(1)
      .max(36)
      .default(12)
      .describe(
        'How many months before the window to learn what is usual from (default 12).',
      ),
    sensitivity: z
      .enum(['low', 'medium', 'high'])
      .default('medium')
      .describe(
        'How readily amounts are flagged. High flags smaller departures from the usual; low flags only extreme ones.',
      ),
    min_amount: z
      .number()
      .min(0)
      .default(20)
      .describe(
        'Ignore transactions smaller than this (major units, default 20), however unusual.',
      ),
    duplicate_window_days: z
      .number()
      .int()
      .min(0)
      .max(14)
      .default(3)
      .describe(
        'How many days apart two identical charges may be and still count as a possible duplicate (default 3).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Findings to return (default 25).'),
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
    history_start: z
      .string()
      .describe('Where the yardstick starts, YYYY-MM-DD.'),
    checked_count: z
      .number()
      .describe('Purchases in the window that were checked.'),
    total_found: z.number().describe('Findings before the limit.'),
    counts: z.object({
      unusual_amount: z.number(),
      new_payee: z.number(),
      possible_duplicate: z.number(),
    }),
    outliers: z.array(outlierSchema),
    notes: z.array(z.string()).describe('Checks that could not run, and why.'),
  },
  async handler(input, ctx) {
    const today = ctx.today();
    const window = {
      start: input.start_date ?? firstDayOf(monthOf(today)),
      end: input.end_date ?? today,
    };
    if (window.start > window.end) {
      throw toolError(
        `start_date (${window.start}) must not be after end_date (${window.end}).`,
      );
    }
    if (input.account_id) await assertKnownAccount(ctx, input.account_id);

    // From the very start, so that "never seen before" really means never.
    const transactions = await loadAnalysisTransactions(ctx, {
      endDate: window.end,
      accountId: input.account_id,
      includeOffBudget: input.include_off_budget,
    });
    const report = findOutliers({
      transactions,
      window,
      historyMonths: input.history_months,
      sensitivity: input.sensitivity,
      minAmount: ctx.amounts.toMinor(input.min_amount),
      duplicateWindowDays: input.duplicate_window_days,
      dataStartDate: await getFirstTransactionDate(ctx),
      money: ctx.amounts,
    });

    const shown = report.outliers.slice(0, input.limit);
    const count = (type: string) =>
      report.outliers.filter(outlier => outlier.type === type).length;
    const { format } = ctx.amounts;
    const lines = [
      report.outliers.length === 0
        ? `Nothing unusual among ${report.checked_count} purchase(s) from ${window.start} to ${window.end}.`
        : `${report.outliers.length} finding(s) among ${report.checked_count} purchase(s) from ${window.start} to ${window.end}${shown.length < report.outliers.length ? `, showing the largest ${shown.length}` : ''}:`,
      ...shown.map(
        outlier =>
          `- [${outlier.type}] ${outlier.transaction.date} ${format(outlier.transaction.amount)} ${outlier.transaction.payee ?? '(no payee)'}: ${outlier.reason} [id: ${outlier.transaction.id}]`,
      ),
      ...report.notes,
    ];

    return {
      data: {
        start_date: window.start,
        end_date: window.end,
        history_start: report.history_start,
        checked_count: report.checked_count,
        total_found: report.outliers.length,
        counts: {
          unusual_amount: count('unusual_amount'),
          new_payee: count('new_payee'),
          possible_duplicate: count('possible_duplicate'),
        },
        outliers: shown,
        notes: report.notes,
      },
      text: lines.join('\n'),
    };
  },
});
