import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import {
  findRulesWithSameConditions,
  updateRuleFromDraft,
  validateRuleDraft,
} from '#actual/rule-edit';
import type { RuleDraft } from '#actual/rule-edit';
import { toRuleActions, toRuleConditions } from '#actual/rule-input';
import { previewMatchesIfPossible } from '#actual/rule-matches';
import { describeRule, loadRule } from '#actual/rules';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';

import {
  ACTIONS_HELP,
  actionSchema,
  CONDITIONS_HELP,
  conditionSchema,
  describeMatches,
  optionalMatchField,
  ruleBodySchema,
  ruleMatchesSchema,
} from './rule-schemas';

const PREVIEW_LIMIT = 10;

export const updateRule = defineTool({
  name: 'update_rule',
  title: 'Change a rule',
  description:
    'Change an existing rule. Give only the parts to change (conditions, actions, match, stage); the rest is kept as it is. The conditions and actions you give replace the old ones as a whole. The preview shows the rule before and after in one sentence each, and which existing transactions the (new) conditions match, as in preview_rule. Changing a rule does not touch transactions that already exist; it affects new and imported ones. The rule Actual keeps behind a schedule cannot be changed here. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD.',
  kind: 'write',
  input: {
    rule_id: z
      .string()
      .min(1)
      .describe('The rule to change (id from get_rules).'),
    conditions: z
      .array(conditionSchema)
      .min(1)
      .optional()
      .describe(`Replaces all conditions. ${CONDITIONS_HELP}`),
    actions: z
      .array(actionSchema)
      .min(1)
      .optional()
      .describe(`Replaces all actions. ${ACTIONS_HELP}`),
    match: optionalMatchField,
    stage: z
      .enum(['pre', 'default', 'post'])
      .optional()
      .describe("Omit to keep the rule's stage."),
  },
  output: {
    rule_id: z.string(),
    before: ruleBodySchema,
    after: ruleBodySchema.describe('The rule as it is (or would be) saved.'),
    matches: ruleMatchesSchema
      .nullable()
      .describe(
        'Existing transactions the new conditions match; null if they cannot be looked up.',
      ),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    if (
      input.conditions === undefined &&
      input.actions === undefined &&
      input.match === undefined &&
      input.stage === undefined
    ) {
      throw toolError(
        'give at least one of conditions, actions, match or stage to change.',
      );
    }

    const { stored, summary } = await loadRule(ctx, input.rule_id);
    const { id: _id, ...before } = summary;
    const lookups = createLookups(ctx);
    const warnings: string[] = [];

    let conditions = stored.conditions;
    if (input.conditions) {
      const converted = await toRuleConditions(ctx, lookups, input.conditions);
      conditions = converted.conditions;
      warnings.push(...converted.warnings);
    }
    const actions = input.actions
      ? await toRuleActions(lookups, input.actions)
      : stored.actions;
    const draft: RuleDraft = {
      stage: input.stage ?? before.stage,
      conditionsOp: input.match
        ? input.match === 'any'
          ? 'or'
          : 'and'
        : stored.conditionsOp,
      conditions,
      actions,
    };

    await validateRuleDraft(ctx, draft);
    const same = await findRulesWithSameConditions(ctx, draft, input.rule_id);
    if (same.length > 0) {
      warnings.push(
        `Another rule has the same conditions (${same.join(', ')}).`,
      );
    }

    const matches = await previewMatchesIfPossible(
      ctx,
      { conditions, match: draft.conditionsOp === 'or' ? 'any' : 'all' },
      { limit: PREVIEW_LIMIT },
    );
    if (!matches) {
      warnings.push(
        'The conditions of this rule use something that cannot be looked up on existing transactions, so there is no preview of its matches.',
      );
    }
    const after = await describeRule(ctx, draft);
    if (!ctx.dryRun) await updateRuleFromDraft(ctx, input.rule_id, draft);

    const text = [
      `${ctx.dryRun ? 'Would change' : 'Changed'} rule [id: ${input.rule_id}]`,
      `  before: ${before.summary}`,
      `  after:  ${after.summary}`,
      ...(matches ? describeMatches(matches, ctx.amounts.format) : []),
      ...warnings,
    ].join('\n');
    return {
      data: { rule_id: input.rule_id, before, after, matches, warnings },
      text,
    };
  },
});
