import { z } from 'zod';

import { getCategoryGroups } from '#actual/categories';
import { defineTool } from '#tools/registry';

export const getCategories = defineTool({
  name: 'get_categories',
  title: 'List categories',
  description:
    'List the budget category groups with the categories in each, in budget order. Income groups hold income categories. Hidden groups and categories (retired ones kept for old transactions) are left out unless include_hidden is true. Use the category ids or exact names with get_transactions.',
  kind: 'read',
  input: {
    include_hidden: z
      .boolean()
      .default(false)
      .describe('Also list hidden groups and categories.'),
  },
  output: {
    groups: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        is_income: z.boolean(),
        hidden: z.boolean(),
        categories: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            hidden: z.boolean(),
          }),
        ),
      }),
    ),
  },
  async handler({ include_hidden }, ctx) {
    const groups = await getCategoryGroups(ctx, {
      includeHidden: include_hidden,
    });

    const lines = groups.flatMap(group => [
      `${group.name}${group.is_income ? ' (income)' : ''}${group.hidden ? ' (hidden)' : ''}`,
      ...group.categories.map(
        category =>
          `  - ${category.name}${category.hidden ? ' (hidden)' : ''} [id: ${category.id}]`,
      ),
    ]);

    return {
      data: { groups },
      text: lines.length > 0 ? lines.join('\n') : 'No categories.',
    };
  },
});
