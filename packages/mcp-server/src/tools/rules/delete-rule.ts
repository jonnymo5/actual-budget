import { z } from 'zod';

import { deleteRuleById } from '#actual/rule-edit';
import { previewMatchesIfPossible } from '#actual/rule-matches';
import { loadRule } from '#actual/rules';
import { defineTool } from '#tools/registry';

import {
  describeMatches,
  ruleBodySchema,
  ruleMatchesSchema,
} from './rule-schemas';

export const deleteRule = defineTool({
  name: 'delete_rule',
  title: 'Delete a rule',
  description:
    'Delete an automation rule so it no longer runs on new and imported transactions. Transactions the rule already changed keep those changes. The preview shows the rule and the existing transactions its conditions match, so you can see what it covered. The rule Actual keeps behind a schedule cannot be deleted here; delete the schedule instead. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD.',
  kind: 'delete',
  input: {
    rule_id: z
      .string()
      .min(1)
      .describe('The rule to delete (id from get_rules).'),
  },
  output: {
    rule_id: z.string(),
    rule: ruleBodySchema.describe('The rule that is (or would be) deleted.'),
    matches: ruleMatchesSchema
      .nullable()
      .describe(
        "Existing transactions the rule's conditions match; null if they cannot be looked up.",
      ),
  },
  async handler({ rule_id }, ctx) {
    const { stored, summary } = await loadRule(ctx, rule_id);
    const { id: _id, ...rule } = summary;

    const matches = await previewMatchesIfPossible(
      ctx,
      {
        conditions: stored.conditions,
        match: stored.conditionsOp === 'or' ? 'any' : 'all',
      },
      { limit: 5 },
    );

    if (!ctx.dryRun) await deleteRuleById(ctx, rule_id);

    const text = [
      `${ctx.dryRun ? 'Would delete' : 'Deleted'} rule [id: ${rule_id}]: ${rule.summary}`,
      ...(matches ? describeMatches(matches, ctx.amounts.format) : []),
      'Transactions the rule already changed keep those changes.',
    ].join('\n');
    return { data: { rule_id, rule, matches }, text };
  },
});
