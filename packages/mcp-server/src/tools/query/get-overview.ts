import { z } from 'zod';

import { buildOverview } from '#actual/overview';
import { defineTool } from '#tools/registry';

export const getOverview = defineTool({
  name: 'get_overview',
  title: 'Budget overview',
  description:
    "Orient yourself: call this first. Returns the budget name, today's date, accounts with current balances, how much transaction history exists (first and last transaction dates), the visible category groups with their category names (hidden ones are left out; get_categories can include them), and whether the data is in sync with the server. Amounts are in major currency units (e.g. dollars, not cents); spending is negative. Dates are YYYY-MM-DD.",
  kind: 'read',
  input: {},
  output: {
    budget_name: z.string(),
    today: z
      .string()
      .describe(
        'Today on the server, YYYY-MM-DD. Use it to resolve "last month".',
      ),
    decimal_places: z
      .number()
      .describe('Decimal places of the budget currency (2 for dollars).'),
    server_version: z
      .string()
      .nullable()
      .describe('Actual sync server version; null if unreachable.'),
    sync: z.object({
      last_synced_at: z.string().nullable().describe('ISO timestamp.'),
      last_error: z
        .string()
        .nullable()
        .describe('Set when the last sync failed; data may then be stale.'),
    }),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        balance: z.number(),
        off_budget: z.boolean(),
        closed: z.boolean(),
      }),
    ),
    closed_account_count: z.number(),
    totals: z.object({
      on_budget: z.number(),
      off_budget: z.number(),
      all: z.number(),
    }),
    transactions: z.object({
      count: z.number(),
      first_date: z.string().nullable(),
      last_date: z.string().nullable(),
    }),
    category_groups: z.array(
      z.object({
        name: z.string(),
        is_income: z.boolean(),
        categories: z.array(z.string()),
      }),
    ),
  },
  async handler(_input, ctx) {
    const overview = await buildOverview(ctx);
    const format = ctx.amounts.format;

    const lines = [
      `Budget: ${overview.budget_name}`,
      `Today: ${overview.today}`,
      `Transactions: ${overview.transactions.count}${overview.transactions.first_date ? ` from ${overview.transactions.first_date} to ${overview.transactions.last_date}` : ''}`,
      overview.sync.last_error
        ? `WARNING: last sync failed (${overview.sync.last_error}); data may be stale.`
        : `Last synced: ${overview.sync.last_synced_at ?? 'never'}`,
      '',
      'Accounts:',
      ...overview.accounts.map(
        account =>
          `- ${account.name}: ${format(account.balance)}${account.off_budget ? ' (off budget)' : ''} [id: ${account.id}]`,
      ),
      `Totals: on budget ${format(overview.totals.on_budget)}, off budget ${format(overview.totals.off_budget)}, all ${format(overview.totals.all)}`,
      ...(overview.closed_account_count > 0
        ? [`(${overview.closed_account_count} closed account(s) not shown)`]
        : []),
      '',
      'Category groups:',
      ...overview.category_groups.map(
        group =>
          `- ${group.name}${group.is_income ? ' (income)' : ''}: ${group.categories.join(', ') || 'no categories'}`,
      ),
    ];

    return { data: overview, text: lines.join('\n') };
  },
});
