import type {
  RuleActionEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';

import { toolError } from '#errors';

import type { ActualContext } from './session';

export type RuleStage = 'pre' | 'default' | 'post';

/** A rule ready to be saved. */
export type RuleDraft = {
  stage: RuleStage;
  conditionsOp: 'and' | 'or';
  conditions: RuleConditionEntity[];
  actions: RuleActionEntity[];
};

// The engine stores the default stage as null.
function toEngineStage(stage: RuleStage) {
  return stage === 'default' ? null : stage;
}

/** Asks Actual whether it accepts the rule, without saving anything. */
export async function validateRuleDraft(
  ctx: ActualContext,
  draft: RuleDraft,
): Promise<void> {
  const { error } = await ctx.lootCore.send('rule-validate', {
    stage: toEngineStage(draft.stage),
    conditionsOp: draft.conditionsOp,
    conditions: draft.conditions,
    actions: draft.actions,
  });
  if (error) {
    throw toolError(
      `Actual rejected the rule (conditions: ${JSON.stringify(error.conditionErrors)}, actions: ${JSON.stringify(error.actionErrors)}).`,
    );
  }
}

/** Saves a new rule and returns its id. */
export async function createRuleFromDraft(
  ctx: ActualContext,
  draft: RuleDraft,
): Promise<string> {
  const created = await ctx.api.createRule({
    stage: draft.stage,
    conditionsOp: draft.conditionsOp,
    conditions: draft.conditions,
    actions: draft.actions,
  });
  return created.id;
}

/** Replaces the rule with this id. */
export async function updateRuleFromDraft(
  ctx: ActualContext,
  id: string,
  draft: RuleDraft,
): Promise<void> {
  await ctx.api.updateRule({
    id,
    stage: draft.stage,
    conditionsOp: draft.conditionsOp,
    conditions: draft.conditions,
    actions: draft.actions,
  });
}

/** Deletes a rule; existing transactions keep whatever the rule already did to them. */
export async function deleteRuleById(
  ctx: ActualContext,
  id: string,
): Promise<void> {
  const deleted = await ctx.api.deleteRule(id);
  if (deleted === false) {
    throw new Error(`Actual did not delete rule ${id}.`);
  }
}

// Two rules have the same conditions when each condition has an equal in the
// other, whatever the order they are written in.
function conditionsKey(
  conditionsOp: string,
  conditions: { field: string; op: string; value: unknown }[],
): string {
  const parts = conditions
    .map(({ field, op, value }) =>
      JSON.stringify([
        field,
        op,
        Array.isArray(value) ? [...value].map(String).sort() : value,
      ]),
    )
    .sort();
  return `${conditions.length > 1 ? conditionsOp : 'single'}:${parts.join('|')}`;
}

/**
 * Ids of the existing rules (apart from `exceptId`, and the ones Actual keeps
 * behind schedules) that already match on exactly these conditions.
 */
export async function findRulesWithSameConditions(
  ctx: ActualContext,
  draft: Pick<RuleDraft, 'conditionsOp' | 'conditions'>,
  exceptId?: string,
): Promise<string[]> {
  const wanted = conditionsKey(draft.conditionsOp, draft.conditions);
  return (await ctx.api.getRules())
    .filter(
      rule =>
        rule.id !== exceptId &&
        !rule.actions.some(action => action.op === 'link-schedule') &&
        conditionsKey(rule.conditionsOp, rule.conditions) === wanted,
    )
    .map(rule => rule.id);
}
