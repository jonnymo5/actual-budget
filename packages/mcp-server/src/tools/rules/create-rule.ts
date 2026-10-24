import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import {
  createRuleFromDraft,
  findRulesWithSameConditions,
  validateRuleDraft,
} from '#actual/rule-edit';
import { toRuleActions, toRuleConditions } from '#actual/rule-input';
import { previewMatches } from '#actual/rule-matches';
import { describeRule } from '#actual/rules';
import { defineTool } from '#tools/registry';

import {
  ACTIONS_HELP,
  actionSchema,
  CONDITIONS_HELP,
  conditionSchema,
  describeMatches,
  matchField,
  ruleBodySchema,
  ruleMatchesSchema,
  stageField,
} from './rule-schemas';

const PREVIEW_LIMIT = 10;

export const createRule = defineTool({
  name: 'create_rule',
  title: 'Create a rule',
  description:
    'Create an automation rule, such as "if the payee is Costco, set the category to Groceries". Actual runs rules on every new and imported transaction, so the rule categorizes future ones by itself; it does not change transactions that already exist (apply_rules_retroactively does that). The preview shows the rule in one sentence and which existing transactions its conditions match, with how they are categorized today (the same result as preview_rule), plus a warning if a rule with the same conditions already exists. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD.',
  kind: 'write',
  input: {
    conditions: z.array(conditionSchema).min(1).describe(CONDITIONS_HELP),
    actions: z.array(actionSchema).min(1).describe(ACTIONS_HELP),
    match: matchField,
    stage: stageField,
  },
  output: {
    rule_id: z
      .string()
      .nullable()
      .describe(
        "The new rule's id; null for a preview, since nothing exists yet.",
      ),
    rule: ruleBodySchema.describe('The rule as it is (or would be) saved.'),
    matches: ruleMatchesSchema.describe(
      'Existing transactions the conditions match. They are not changed by creating the rule.',
    ),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    const lookups = createLookups(ctx);
    const { conditions, warnings } = await toRuleConditions(
      ctx,
      lookups,
      input.conditions,
    );
    const actions = await toRuleActions(lookups, input.actions);
    const draft = {
      stage: input.stage,
      conditionsOp: input.match === 'any' ? ('or' as const) : ('and' as const),
      conditions,
      actions,
    };

    await validateRuleDraft(ctx, draft);
    const same = await findRulesWithSameConditions(ctx, draft);
    if (same.length > 0) {
      warnings.push(
        `A rule with the same conditions already exists (${same.join(', ')}). Consider update_rule instead of adding a second one.`,
      );
    }

    const matches = await previewMatches(
      ctx,
      { conditions, match: input.match },
      { limit: PREVIEW_LIMIT },
    );
    const rule = await describeRule(ctx, draft);
    const ruleId = ctx.dryRun ? null : await createRuleFromDraft(ctx, draft);

    const text = [
      `${ctx.dryRun ? 'Would create' : 'Created'} rule${ruleId ? ` [id: ${ruleId}]` : ''}: ${rule.summary}`,
      ...describeMatches(matches, ctx.amounts.format),
      'The rule applies to new and imported transactions; apply_rules_retroactively would also update the existing matches.',
      ...warnings,
    ].join('\n');
    return { data: { rule_id: ruleId, rule, matches, warnings }, text };
  },
});
