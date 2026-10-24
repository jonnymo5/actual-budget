import { z } from 'zod';

import { getAccountsWithBalances } from '#actual/accounts';
import { defineTool } from '#tools/registry';

export const listAccounts = defineTool({
  name: 'list_accounts',
  title: 'List accounts',
  description:
    'List the budget accounts with their current balances. Balances and totals are in major currency units (e.g. dollars, not cents); negative means money owed. "Off budget" accounts (investments, mortgages, ...) are tracked but not part of the spending budget. Closed accounts are hidden unless include_closed is true.',
  kind: 'read',
  input: {
    include_closed: z
      .boolean()
      .default(false)
      .describe('Also list closed accounts.'),
  },
  output: {
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        balance: z.number().describe('Current balance, major currency units.'),
        off_budget: z.boolean(),
        closed: z.boolean(),
      }),
    ),
    totals: z.object({
      on_budget: z.number(),
      off_budget: z.number(),
      all: z.number(),
    }),
  },
  async handler({ include_closed }, ctx) {
    const { accounts, totals } = await getAccountsWithBalances(ctx, {
      includeClosed: include_closed,
    });

    const format = ctx.amounts.format;
    const lines = accounts.map(
      account =>
        `${account.name}: ${format(account.balance)}${account.off_budget ? ' (off budget)' : ''}${account.closed ? ' (closed)' : ''} [id: ${account.id}]`,
    );
    const text = [
      accounts.length > 0 ? lines.join('\n') : 'No accounts.',
      `Totals: on budget ${format(totals.on_budget)}, off budget ${format(totals.off_budget)}, all ${format(totals.all)}`,
    ].join('\n');

    return { data: { accounts, totals }, text };
  },
});
