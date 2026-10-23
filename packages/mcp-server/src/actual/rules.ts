import { z } from 'zod';

import { toolError } from '#errors';

import type { ActualContext } from './session';

export type RuleCondition = {
  field: string;
  op: string;
  /** The stored value; amounts are converted to major units. */
  value: unknown;
  /** The value as text, with ids replaced by names. */
  value_text: string;
};

export type RuleAction = {
  op: string;
  field: string | null;
  value: unknown;
  value_text: string;
};

export type RuleSummary = {
  id: string;
  /** Rules run in three passes: pre, then default, then post. */
  stage: 'pre' | 'default' | 'post';
  /** "all": every condition must match; "any": one is enough. */
  match: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** The whole rule in one sentence. */
  summary: string;
};

const conditionSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.unknown(),
});

const actionSchema = z.object({
  op: z.string(),
  field: z.string().nullish(),
  value: z.unknown(),
  options: z.object({ method: z.string().nullish() }).nullish(),
});

const ruleSchema = z.object({
  id: z.string(),
  stage: z.string().nullish(),
  conditionsOp: z.string().nullish(),
  conditions: z.array(conditionSchema),
  actions: z.array(actionSchema),
});

const betweenSchema = z.object({ num1: z.number(), num2: z.number() });

const CONDITION_OPS: Record<string, string> = {
  is: 'is',
  isNot: 'is not',
  oneOf: 'is one of',
  notOneOf: 'is not one of',
  contains: 'contains',
  doesNotContain: 'does not contain',
  matches: 'matches',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  isapprox: 'is approximately',
  isbetween: 'is between',
  hasTags: 'has tags',
  hasAnyTag: 'has any of the tags',
  onBudget: 'is on budget',
  offBudget: 'is off budget',
};

const FIELD_LABELS: Record<string, string> = {
  imported_payee: 'imported payee',
  category_group: 'category group',
};

// Names for the ids that rules refer to.
type Names = {
  payee: Map<string, string>;
  category: Map<string, string>;
  category_group: Map<string, string>;
  account: Map<string, string>;
  schedule: Map<string, string>;
};

async function loadNames(ctx: ActualContext): Promise<Names> {
  const groups = await ctx.api.getCategoryGroups();
  const schedules = await ctx.api.getSchedules();
  return {
    payee: new Map((await ctx.api.getPayees()).map(p => [p.id, p.name])),
    category: new Map(
      groups.flatMap(group =>
        (group.categories ?? []).map(
          category => [category.id, category.name] as const,
        ),
      ),
    ),
    category_group: new Map(groups.map(group => [group.id, group.name])),
    account: new Map((await ctx.api.getAccounts()).map(a => [a.id, a.name])),
    schedule: new Map(schedules.map(s => [s.id, s.name ?? s.id])),
  };
}

function isNamedField(field: string): field is keyof Names {
  return (
    field === 'payee' ||
    field === 'category' ||
    field === 'category_group' ||
    field === 'account'
  );
}

function renderValue(
  ctx: ActualContext,
  names: Names,
  field: string | null,
  value: unknown,
): { value: unknown; text: string } {
  const { toMajor, format } = ctx.amounts;

  if (field === 'amount') {
    if (typeof value === 'number') {
      return { value: toMajor(value), text: format(toMajor(value)) };
    }
    const between = betweenSchema.safeParse(value);
    if (between.success) {
      const lower = toMajor(between.data.num1);
      const upper = toMajor(between.data.num2);
      return {
        value: { num1: lower, num2: upper },
        text: `${format(lower)} and ${format(upper)}`,
      };
    }
  }

  // "category is empty" is how a rule says "has no category yet".
  if (value === null) return { value: null, text: 'empty' };

  const label = (item: unknown): string => {
    if (typeof item === 'string' && field !== null && isNamedField(field)) {
      return names[field].get(item) ?? item;
    }
    return typeof item === 'string' ? item : JSON.stringify(item);
  };
  if (Array.isArray(value)) {
    return { value, text: value.map(label).join(', ') };
  }
  return { value, text: label(value) };
}

function describeCondition(condition: RuleCondition): string {
  const field = FIELD_LABELS[condition.field] ?? condition.field;
  const op = CONDITION_OPS[condition.op] ?? condition.op;
  const needsValue =
    condition.op !== 'onBudget' && condition.op !== 'offBudget';
  return `${field} ${op}${needsValue ? ` ${condition.value_text}` : ''}`;
}

function describeAction(action: RuleAction): string {
  switch (action.op) {
    case 'set':
      return `set ${FIELD_LABELS[action.field ?? ''] ?? action.field} to ${action.value_text}`;
    case 'prepend-notes':
      return `put "${action.value_text}" at the start of the notes`;
    case 'append-notes':
      return `add "${action.value_text}" to the end of the notes`;
    case 'link-schedule':
      return `link to schedule ${action.value_text}`;
    case 'delete-transaction':
      return 'delete the transaction';
    case 'set-split-amount':
      return `set a split amount to ${action.value_text}`;
    default:
      return `${action.op} ${action.value_text}`.trim();
  }
}

function summarizeRule(
  ctx: ActualContext,
  names: Names,
  raw: z.output<typeof ruleSchema>,
): RuleSummary {
  const conditions = raw.conditions.map(condition => {
    const { value, text } = renderValue(
      ctx,
      names,
      condition.field,
      condition.value,
    );
    return {
      field: condition.field,
      op: condition.op,
      value,
      value_text: text,
    };
  });
  const actions = raw.actions.map(action => {
    // A split amount is money only when it is a fixed amount; otherwise it is
    // a percentage or a formula.
    const isMoney =
      action.field === 'amount' ||
      (action.op === 'set-split-amount' &&
        action.options?.method === 'fixed-amount');
    const target =
      action.op === 'link-schedule' ? null : (action.field ?? null);
    const rendered =
      action.op === 'link-schedule' && typeof action.value === 'string'
        ? {
            value: action.value,
            text: names.schedule.get(action.value) ?? action.value,
          }
        : renderValue(ctx, names, isMoney ? 'amount' : target, action.value);
    return {
      op: action.op,
      field: action.field ?? null,
      value: rendered.value,
      value_text: rendered.text,
    };
  });

  const match = raw.conditionsOp === 'or' ? 'any' : 'all';
  const stage =
    raw.stage === 'pre' || raw.stage === 'post' ? raw.stage : 'default';
  const joiner = match === 'any' ? ' or ' : ' and ';
  const summary = `${stage === 'default' ? '' : `[${stage}] `}If ${
    conditions.map(describeCondition).join(joiner) || 'any transaction'
  }, then ${actions.map(describeAction).join('; ') || 'do nothing'}`;

  return { id: raw.id, stage, match, conditions, actions, summary };
}

/** A rule without an id: one that has not been saved yet. */
export type RuleBody = Omit<RuleSummary, 'id'>;

type UnsavedRule = {
  stage: 'pre' | 'default' | 'post' | null;
  conditionsOp: 'and' | 'or';
  conditions: unknown[];
  actions: unknown[];
};

/** Describes a rule that does not exist yet, in the same words as `get_rules`. */
export async function describeRule(
  ctx: ActualContext,
  rule: UnsavedRule,
): Promise<RuleBody> {
  const { id: _id, ...body } = summarizeRule(
    ctx,
    await loadNames(ctx),
    ruleSchema.parse({ id: 'unsaved', ...rule }),
  );
  return body;
}

/**
 * One rule as the API stores it, plus its description. Rules that belong to a
 * schedule are refused: Actual keeps them in step with the schedule.
 */
export async function loadRule(ctx: ActualContext, ruleId: string) {
  const stored = (await ctx.api.getRules()).find(rule => rule.id === ruleId);
  if (!stored) {
    throw toolError(
      `unknown rule_id "${ruleId}". Use get_rules to list the rules and their ids.`,
    );
  }
  const parsed = ruleSchema.parse(stored);
  if (parsed.actions.some(action => action.op === 'link-schedule')) {
    throw toolError(
      `rule "${ruleId}" is the one Actual keeps behind a schedule, so it cannot be changed directly. Change the schedule instead (get_schedules lists them).`,
    );
  }
  return {
    stored,
    summary: summarizeRule(ctx, await loadNames(ctx), parsed),
  };
}

/**
 * All rules, or only those that mention one payee. Ids in each rule are
 * replaced by names in `value_text` and `summary`.
 */
export async function listRules(
  ctx: ActualContext,
  {
    payeeId,
    includeScheduleRules,
  }: { payeeId: string | undefined; includeScheduleRules: boolean },
): Promise<RuleSummary[]> {
  if (payeeId !== undefined) {
    const payees = await ctx.api.getPayees();
    if (!payees.some(payee => payee.id === payeeId)) {
      throw toolError(
        `unknown payee_id "${payeeId}". Use get_payees to find the id of a payee.`,
      );
    }
  }

  const raw =
    payeeId === undefined
      ? await ctx.api.getRules()
      : await ctx.api.getPayeeRules(payeeId);
  // Every schedule has a rule of its own behind the scenes that links matching
  // transactions to it. It is not a rule anyone wrote, so leave it out unless
  // asked for.
  const rules = z
    .array(ruleSchema)
    .parse(raw)
    .filter(
      rule =>
        includeScheduleRules ||
        !rule.actions.some(action => action.op === 'link-schedule'),
    );
  const names = await loadNames(ctx);
  return rules.map(rule => summarizeRule(ctx, names, rule));
}
