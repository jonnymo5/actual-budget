import { z } from 'zod';

import type { Comparison, SummaryKind } from '#analysis/spending';

export const comparisonSchema = z.object({
  previous_total: z.number().describe('The earlier amount, major units.'),
  change: z
    .number()
    .describe('This amount minus the earlier one, major units, signed.'),
  percent_change: z
    .number()
    .nullable()
    .describe(
      'Change in size relative to the earlier amount, in percent. Positive means more spent (spending), more earned (income) or a larger net (all), whatever the sign of the amounts; null when the earlier amount was zero.',
    ),
  direction: z
    .enum(['higher', 'lower', 'unchanged'])
    .describe(
      'higher: more spent, more earned or a larger net. lower: the opposite.',
    ),
});

export const transactionBriefSchema = z.object({
  id: z.string(),
  date: z.string().describe('YYYY-MM-DD.'),
  amount: z.number().describe('Major units, signed: spending is negative.'),
  account: z.string().nullable(),
  payee: z.string().nullable(),
  category: z.string().nullable(),
});

export const includeOffBudget = z
  .boolean()
  .default(false)
  .describe(
    'Also count off-budget (tracking) accounts, such as investments. Off by default, because their money is not part of the budget.',
  );

const WORDS: Record<SummaryKind, { higher: string; lower: string }> = {
  spending: { higher: 'more spent', lower: 'less spent' },
  income: { higher: 'more earned', lower: 'less earned' },
  all: { higher: 'higher net', lower: 'lower net' },
};

/** "vs -380.00: 8.6% more spent", for the text a client shows the model. */
export function describeComparison(
  kind: SummaryKind,
  comparison: Comparison,
  format: (amount: number) => string,
): string {
  const previous = `vs ${format(comparison.previous_total)}`;
  if (comparison.direction === 'unchanged') return `${previous}: unchanged`;

  const words = WORDS[kind][comparison.direction];
  return comparison.percent_change === null
    ? `${previous}: ${words}`
    : `${previous}: ${Math.abs(comparison.percent_change)}% ${words}`;
}
