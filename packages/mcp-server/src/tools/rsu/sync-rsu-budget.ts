import { z } from 'zod';

import { defineTool } from '#tools/registry';

const RSU_BUDGET_SYNC_PREF = 'rsu-budget-sync';

export const syncRsuBudget = defineTool({
  name: 'sync_rsu_budget',
  title: 'Budget RSU income',
  description:
    'Budget the income categories that RSU deposits land in, from this month to a year ahead: each month gets the summed net of every vest dated in it, across all grants in that category, and 0 when nothing vests. Vests are valued the same way get_rsu_grants does (recorded deposit, then vest-date price, then the current quote). Whatever was budgeted in those categories for those months is replaced; past months are never touched, and a month with a vest that has no price yet is left alone. Works only in a tracking budget, because an envelope budget cannot budget income. Pass auto true to keep doing this once a day after prices refresh (a synced setting, also on the RSU Grants page), or false to stop. Amounts are in major currency units (e.g. dollars, not cents); months are YYYY-MM.',
  kind: 'write',
  input: {
    auto: z
      .boolean()
      .optional()
      .describe(
        'Turn the daily budget sync on (true) or off (false). Leave out to keep the current setting.',
      ),
  },
  output: {
    budget_type: z.enum(['tracking', 'envelope']),
    auto: z
      .boolean()
      .describe('Whether the daily sync is on, after this call is applied.'),
    changes: z.array(
      z.object({
        category: z.string(),
        month: z.string(),
        before: z.number(),
        after: z.number(),
      }),
    ),
    unchanged: z
      .number()
      .describe('Category months that already held the right amount.'),
    unpriced: z
      .array(
        z.object({
          category: z.string(),
          month: z.string(),
          ticker: z.string(),
        }),
      )
      .describe('Months left alone because a vest in them has no price.'),
    ignored_grants: z
      .array(z.string())
      .describe(
        'Grants with no deposit category, or one that is not an income category.',
      ),
  },
  async handler({ auto }, ctx) {
    const prefs = await ctx.lootCore.send('preferences/get');
    const autoBefore = prefs[RSU_BUDGET_SYNC_PREF] === 'true';
    const autoAfter = auto ?? autoBefore;

    const result = await ctx.lootCore.send('rsu/sync-budget', {
      dryRun: ctx.dryRun,
    });
    if (!ctx.dryRun && auto !== undefined && auto !== autoBefore) {
      await ctx.lootCore.send('preferences/save', {
        id: RSU_BUDGET_SYNC_PREF,
        value: auto ? 'true' : 'false',
      });
    }

    const categoryNames = new Map(
      (await ctx.api.getCategories()).map(
        category => [category.id, category.name] as const,
      ),
    );
    const name = (id: string) => categoryNames.get(id) ?? id;
    const { toMajor, format } = ctx.amounts;
    const changes = result.changes.map(change => ({
      category: name(change.category),
      month: change.month,
      before: toMajor(change.before),
      after: toMajor(change.after),
    }));
    const data = {
      budget_type:
        result.skipped === 'envelope-budget'
          ? ('envelope' as const)
          : ('tracking' as const),
      auto: autoAfter,
      changes,
      unchanged: result.unchanged,
      unpriced: result.unpriced.map(item => ({
        ...item,
        category: name(item.category),
      })),
      ignored_grants: result.ignoredGrants,
    };

    if (result.skipped === 'envelope-budget') {
      return {
        data,
        text: 'This is an envelope budget, which cannot budget income, so nothing was changed.',
      };
    }

    const verb = ctx.dryRun ? 'Would change' : 'Changed';
    const lines = changes.map(
      change =>
        `${change.month} ${change.category}: ${format(change.before)} → ${format(change.after)}`,
    );
    const summary =
      changes.length === 0
        ? `The RSU budget is already up to date (${result.unchanged} months checked).`
        : `${verb} ${changes.length} budgeted months:\n${lines.join('\n')}`;
    const notes = [
      data.unpriced.length > 0 &&
        `Left alone because a vest has no price: ${data.unpriced.map(item => `${item.month} ${item.category} (${item.ticker})`).join(', ')}.`,
      data.ignored_grants.length > 0 &&
        `${data.ignored_grants.length} grants have no income category and were skipped.`,
      auto !== undefined &&
        auto !== autoBefore &&
        `${ctx.dryRun ? 'Would turn' : 'Turned'} the daily budget sync ${auto ? 'on' : 'off'}.`,
    ].filter(Boolean);
    return { data, text: [summary, ...notes].join('\n') };
  },
});
