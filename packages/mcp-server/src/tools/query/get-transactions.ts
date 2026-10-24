import { z } from 'zod';

import { queryTransactions, transactionRowSchema } from '#actual/transactions';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const getTransactions = defineTool({
  name: 'get_transactions',
  title: 'Get transactions',
  description:
    'Search transactions across all accounts (or one) between two dates, newest first. Amounts are in major currency units (e.g. dollars, not cents) and signed: spending is negative, income is positive. Dates are YYYY-MM-DD and both ends are inclusive. Split transactions appear as one row per split line. The result also reports total_count and total_amount (net sum) over ALL matches, not just the returned page, so use it to answer "how much did I spend" without paging; page with limit/offset only when you need the rows.',
  kind: 'read',
  input: {
    account_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only this account (id from list_accounts). Omit for all accounts.',
      ),
    start_date: isoDate.describe('First day to include, YYYY-MM-DD.'),
    end_date: isoDate.describe('Last day to include, YYYY-MM-DD.'),
    category: z
      .string()
      .min(1)
      .optional()
      .describe('A category id or exact category name (case-insensitive).'),
    payee: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Text found in the payee name or the original bank description (case-insensitive), e.g. "costco"; or a payee id.',
      ),
    min_amount: z
      .number()
      .optional()
      .describe(
        'Smallest signed amount to include, major units. Spending is negative, so purchases of at most 50 need min_amount -50.',
      ),
    max_amount: z
      .number()
      .optional()
      .describe(
        'Largest signed amount to include, major units. Purchases of at least 50 need max_amount -50.',
      ),
    search_text: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Text found in the notes, payee name or original bank description (case-insensitive).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Rows per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Rows to skip, for paging.'),
  },
  output: {
    transactions: z.array(transactionRowSchema),
    total_count: z
      .number()
      .describe('Matches across all pages, not just this one.'),
    total_amount: z
      .number()
      .describe('Net sum of all matches, major units, not just this page.'),
    offset: z.number(),
    has_more: z.boolean(),
  },
  async handler(input, ctx) {
    const page = await queryTransactions(ctx, {
      accountId: input.account_id,
      startDate: input.start_date,
      endDate: input.end_date,
      category: input.category,
      payee: input.payee,
      minAmount: input.min_amount,
      maxAmount: input.max_amount,
      searchText: input.search_text,
      limit: input.limit,
      offset: input.offset,
    });

    const format = ctx.amounts.format;
    const header =
      page.total_count === 0
        ? 'No transactions matched.'
        : `${page.total_count} matching transaction(s), net ${format(page.total_amount)}. Showing ${page.offset + 1}-${page.offset + page.transactions.length}.`;
    const rows = page.transactions.map(transaction =>
      [
        transaction.date,
        format(transaction.amount),
        transaction.payee ?? '(no payee)',
        transaction.category ??
          (transaction.is_transfer ? '(transfer)' : '(uncategorized)'),
        transaction.account ?? '',
        transaction.notes ?? '',
        `[id: ${transaction.id}]`,
      ].join(' | '),
    );
    const more = page.has_more
      ? [
          `More results: call again with offset ${page.offset + page.transactions.length}.`,
        ]
      : [];

    return { data: page, text: [header, ...rows, ...more].join('\n') };
  },
});
