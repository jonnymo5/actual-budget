import { z } from 'zod';

import { listUncategorized } from '#actual/uncategorized';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SAMPLES_PER_GROUP = 5;

export const getUncategorized = defineTool({
  name: 'get_uncategorized',
  title: 'Find uncategorized transactions',
  description: `List the transactions that still have no category, grouped by payee (biggest groups first) so one decision can cover many of them. This is where to start when categorizing. Each group has its count, net total, first and last date, the categories that payee's categorized transactions already use (usual_categories, most common first, a strong hint for the right answer), and its ${SAMPLES_PER_GROUP} newest transactions with notes and the original bank description. Amounts are in major currency units (e.g. dollars, not cents) and signed: spending is negative. Dates are YYYY-MM-DD. Transfers between accounts, off-budget (tracking) accounts and the summary line of a split are not counted, because Actual does not categorize them. Then use categorize_transactions to assign categories, and create_rule to categorize future ones automatically.`,
  kind: 'read',
  input: {
    start_date: isoDate
      .optional()
      .describe('Only transactions on or after this day, YYYY-MM-DD.'),
    end_date: isoDate
      .optional()
      .describe('Only transactions on or before this day, YYYY-MM-DD.'),
    account_id: z
      .string()
      .min(1)
      .optional()
      .describe('Only this account (id from list_accounts).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `Payee groups per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Payee groups to skip, for paging.'),
  },
  output: {
    total_count: z
      .number()
      .describe('Uncategorized transactions across all groups.'),
    total_amount: z
      .number()
      .describe('Net sum of all of them, major units, signed.'),
    group_count: z.number().describe('How many payee groups there are.'),
    groups: z.array(
      z.object({
        payee_id: z
          .string()
          .nullable()
          .describe('Null for transactions that have no payee.'),
        payee: z.string().nullable(),
        count: z.number(),
        total_amount: z.number().describe('Major units, signed.'),
        first_date: z.string().describe('YYYY-MM-DD.'),
        last_date: z.string().describe('YYYY-MM-DD.'),
        usual_categories: z.array(
          z.object({
            category_id: z.string(),
            category: z.string(),
            count: z
              .number()
              .describe(
                "How many of this payee's categorized transactions use it.",
              ),
          }),
        ),
        transactions: z.array(
          z.object({
            id: z.string(),
            date: z.string().describe('YYYY-MM-DD.'),
            amount: z.number().describe('Major units, signed.'),
            account: z.string().nullable(),
            notes: z.string().nullable(),
            imported_payee: z
              .string()
              .nullable()
              .describe('The description the bank sent, before any renaming.'),
          }),
        ),
      }),
    ),
    offset: z.number(),
    has_more: z.boolean(),
  },
  async handler(input, ctx) {
    if (
      input.start_date &&
      input.end_date &&
      input.start_date > input.end_date
    ) {
      throw toolError(
        `start_date (${input.start_date}) must not be after end_date (${input.end_date}).`,
      );
    }
    const page = await listUncategorized(ctx, {
      startDate: input.start_date,
      endDate: input.end_date,
      accountId: input.account_id,
      limit: input.limit,
      offset: input.offset,
      samplesPerGroup: SAMPLES_PER_GROUP,
    });

    const { format } = ctx.amounts;
    if (page.total_count === 0) {
      return { data: page, text: 'Nothing is uncategorized.' };
    }
    const lines = [
      `${page.total_count} uncategorized transaction(s), net ${format(page.total_amount)}, in ${page.group_count} payee group(s). Showing groups ${page.offset + 1}-${page.offset + page.groups.length}.`,
    ];
    for (const group of page.groups) {
      const usual =
        group.usual_categories.length > 0
          ? ` Usually: ${group.usual_categories.map(entry => `${entry.category} (${entry.count})`).join(', ')}.`
          : '';
      lines.push(
        `${group.payee ?? '(no payee)'}: ${group.count} transaction(s), net ${format(group.total_amount)}, ${group.first_date} to ${group.last_date}.${usual}`,
      );
      for (const transaction of group.transactions) {
        const original =
          transaction.imported_payee &&
          transaction.imported_payee !== group.payee
            ? ` "${transaction.imported_payee}"`
            : '';
        lines.push(
          `  ${transaction.date} | ${format(transaction.amount)} | ${transaction.account ?? ''}${original}${transaction.notes ? ` | ${transaction.notes}` : ''} [id: ${transaction.id}]`,
        );
      }
      if (group.count > group.transactions.length) {
        lines.push(
          `  ... and ${group.count - group.transactions.length} more (get_transactions with a payee filter lists them).`,
        );
      }
    }
    if (page.has_more) {
      lines.push(
        `More groups: call again with offset ${page.offset + page.groups.length}.`,
      );
    }
    return { data: page, text: lines.join('\n') };
  },
});
