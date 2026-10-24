import { z } from 'zod';

import { searchPayees } from '#actual/payees';
import { defineTool } from '#tools/registry';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const getPayees = defineTool({
  name: 'get_payees',
  title: 'List payees',
  description:
    'List payees (merchants and other counterparties) alphabetically, optionally only those whose name contains some text. A payee is the cleaned-up name shown on a transaction; the raw bank description is separate. Transfers between accounts appear as payees flagged is_transfer. Large budgets have thousands of payees, so search rather than paging through all of them.',
  kind: 'read',
  input: {
    search: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only payees whose name contains this text (case-insensitive).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `Payees per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Payees to skip, for paging.'),
  },
  output: {
    payees: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        is_transfer: z.boolean(),
        transfer_account_id: z.string().nullable(),
      }),
    ),
    total_count: z.number().describe('Matches across all pages.'),
    offset: z.number(),
    has_more: z.boolean(),
  },
  async handler(input, ctx) {
    const page = await searchPayees(ctx, {
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    });

    const header =
      page.total_count === 0
        ? 'No payees matched.'
        : `${page.total_count} payee(s). Showing ${page.offset + 1}-${page.offset + page.payees.length}.`;
    const rows = page.payees.map(
      payee =>
        `${payee.name}${payee.is_transfer ? ' (transfer)' : ''} [id: ${payee.id}]`,
    );
    const more = page.has_more
      ? [
          `More results: call again with offset ${page.offset + page.payees.length}.`,
        ]
      : [];

    return { data: page, text: [header, ...rows, ...more].join('\n') };
  },
});
