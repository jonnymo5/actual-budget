import { z } from 'zod';

import { listBudgetMonths } from '#actual/budget-months';
import { defineTool } from '#tools/registry';

export const getBudgetMonths = defineTool({
  name: 'get_budget_months',
  title: 'List budget months',
  description:
    'List the months that have a budget, oldest first, as YYYY-MM. Call this before get_budget_month to see which months can be asked for.',
  kind: 'read',
  input: {},
  output: {
    months: z
      .array(z.string())
      .describe('Budget months, YYYY-MM, oldest first.'),
  },
  async handler(_input, ctx) {
    const months = await listBudgetMonths(ctx);

    const text =
      months.length === 0
        ? 'No budget months.'
        : `${months.length} month(s), from ${months[0]} to ${months[months.length - 1]}.`;
    return { data: { months }, text };
  },
});
