import type {
  RuleActionEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';

import { toolError } from '#errors';

import { isValidIsoDate } from './amounts';
import type { Lookups } from './lookup';
import type { ActualContext } from './session';

// Actual's rule engine knows more fields and operators than this. These are the
// ones where matching existing transactions (the preview, and applying a rule
// retroactively) behaves exactly like running the rule on a new transaction.
// Left out on purpose: `contains` and friends on a payee (the engine compares
// the payee's id, the preview its name), and the fields that only exist while a
// transaction is imported (`payee_name`).
export const CONDITION_FIELDS = [
  'payee',
  'imported_payee',
  'notes',
  'amount',
  'date',
  'category',
  'account',
] as const;

export const CONDITION_OPS = [
  'is',
  'isNot',
  'oneOf',
  'notOneOf',
  'contains',
  'doesNotContain',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'isapprox',
  'isbetween',
] as const;

export type ConditionField = (typeof CONDITION_FIELDS)[number];
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type ConditionValue =
  | string
  | number
  | string[]
  | { num1: number; num2: number }
  | null;

export type ConditionInput = {
  field: ConditionField;
  op: ConditionOp;
  value: ConditionValue;
};

export const OPS_BY_FIELD = {
  payee: ['is', 'isNot', 'oneOf', 'notOneOf'],
  imported_payee: [
    'is',
    'isNot',
    'oneOf',
    'notOneOf',
    'contains',
    'doesNotContain',
    'matches',
  ],
  notes: ['is', 'isNot', 'contains', 'doesNotContain', 'matches'],
  amount: ['is', 'isapprox', 'isbetween', 'gt', 'gte', 'lt', 'lte'],
  date: ['is', 'gt', 'gte', 'lt', 'lte'],
  category: ['is', 'isNot', 'oneOf', 'notOneOf'],
  account: ['is', 'isNot', 'oneOf', 'notOneOf'],
} as const satisfies Record<ConditionField, readonly ConditionOp[]>;

export const ACTION_OPS = ['set', 'append-notes', 'prepend-notes'] as const;
export const ACTION_FIELDS = ['category', 'payee', 'notes'] as const;

export type ActionInput = {
  op: (typeof ACTION_OPS)[number];
  field?: (typeof ACTION_FIELDS)[number];
  value: string;
};

export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 5;

function isOneOfOp(op: ConditionOp) {
  return op === 'oneOf' || op === 'notOneOf';
}

// What the engine accepts for each operator; anything else is a mistake of this
// module, not of the caller, so it must never reach the budget.
function isRuleCondition(candidate: {
  field: string;
  op: string;
  value: unknown;
}): candidate is RuleConditionEntity {
  const field = CONDITION_FIELDS.find(name => name === candidate.field);
  if (!field) return false;
  const ops: readonly string[] = OPS_BY_FIELD[field];
  if (!ops.includes(candidate.op)) return false;

  const { op, value } = candidate;
  if (op === 'oneOf' || op === 'notOneOf') {
    return Array.isArray(value) && value.length > 0;
  }
  if (op === 'isbetween') {
    return typeof value === 'object' && value !== null && 'num1' in value;
  }
  return value === null ? field === 'category' : typeof value !== 'object';
}

function problem(index: number, message: string): never {
  throw toolError(`conditions[${index}]: ${message}`);
}

function describeAllowed(field: ConditionField) {
  return `${field} supports ${OPS_BY_FIELD[field].join(', ')}`;
}

async function convertValue(
  ctx: ActualContext,
  lookups: Lookups,
  index: number,
  condition: ConditionInput,
  warnings: string[],
): Promise<string | number | string[] | { num1: number; num2: number } | null> {
  const { field, op, value } = condition;

  switch (field) {
    case 'payee':
    case 'category':
    case 'account': {
      const resolve = lookups[field];
      if (isOneOfOp(op)) {
        if (!Array.isArray(value) || value.length === 0) {
          return problem(
            index,
            `${op} needs a non-empty list of ${field} names or ids.`,
          );
        }
        const ids = await Promise.all(
          value.map(async item => (await resolve(item)).id),
        );
        return [...new Set(ids)];
      }
      if (value === null && field === 'category') return null;
      if (typeof value !== 'string' || value.trim() === '') {
        return problem(
          index,
          `${op} needs one ${field} name or id${field === 'category' ? ' (or null for no category)' : ''}.`,
        );
      }
      return (await resolve(value)).id;
    }

    case 'imported_payee':
    case 'notes': {
      if (isOneOfOp(op)) {
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.some(item => item.trim() === '')
        ) {
          return problem(index, `${op} needs a non-empty list of texts.`);
        }
        return value;
      }
      if (typeof value !== 'string' || value === '') {
        return problem(index, `${op} needs a non-empty text.`);
      }
      if (op === 'matches') {
        // Actual lowercases the text of a rule and compares it with the
        // lowercased field, so an escape such as \D would turn into \d.
        if (value !== value.toLowerCase()) {
          return problem(
            index,
            'matches is case-insensitive and Actual lowercases the pattern, so write it in lowercase.',
          );
        }
        try {
          new RegExp(value);
        } catch (error) {
          return problem(
            index,
            `"${value}" is not a valid regular expression (${error instanceof Error ? error.message : String(error)}).`,
          );
        }
      }
      if (op === 'contains' || op === 'doesNotContain') {
        if (value.includes('%')) {
          warnings.push(
            `conditions[${index}]: "%" in "${value}" acts as a wildcard when looking up existing transactions, so the preview may list a few more than the rule itself would match.`,
          );
        }
      }
      return value;
    }

    case 'amount': {
      const { toMinor } = ctx.amounts;
      if (op === 'isbetween') {
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value) ||
          !Number.isFinite(value.num1) ||
          !Number.isFinite(value.num2)
        ) {
          return problem(
            index,
            'isbetween needs a value like {"num1": -50, "num2": -10} (major units).',
          );
        }
        return { num1: toMinor(value.num1), num2: toMinor(value.num2) };
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return problem(index, `${op} needs a number in major units.`);
      }
      return toMinor(value);
    }

    case 'date': {
      if (typeof value !== 'string' || !isValidIsoDate(value)) {
        return problem(index, `${op} needs a date written YYYY-MM-DD.`);
      }
      return value;
    }

    default:
      throw new Error(
        `unhandled condition field: ${String(field satisfies never)}`,
      );
  }
}

/**
 * The tool's conditions as the rule engine stores them: ids instead of names,
 * amounts in minor units. Throws, naming the condition, for anything the
 * engine would not treat the way the preview does.
 */
export async function toRuleConditions(
  ctx: ActualContext,
  lookups: Lookups,
  inputs: ConditionInput[],
): Promise<{ conditions: RuleConditionEntity[]; warnings: string[] }> {
  if (inputs.length === 0 || inputs.length > MAX_CONDITIONS) {
    throw toolError(
      `give between 1 and ${MAX_CONDITIONS} conditions (a rule with none would match every transaction).`,
    );
  }

  const warnings: string[] = [];
  const conditions: RuleConditionEntity[] = [];
  for (const [index, input] of inputs.entries()) {
    const allowed: readonly string[] = OPS_BY_FIELD[input.field];
    if (!allowed.includes(input.op)) {
      problem(
        index,
        `${input.op} is not available for ${input.field}; ${describeAllowed(input.field)}.`,
      );
    }
    const value = await convertValue(ctx, lookups, index, input, warnings);
    const candidate = { field: input.field, op: input.op, value };
    if (!isRuleCondition(candidate)) {
      throw new Error(
        `built an invalid rule condition: ${JSON.stringify(candidate)}`,
      );
    }
    conditions.push(candidate);
  }
  return { conditions, warnings };
}

/**
 * The tool's actions as the rule engine stores them. Only setting a category,
 * payee or notes, and adding text to the notes, are offered: they can be
 * previewed exactly and applied to existing transactions.
 */
export async function toRuleActions(
  lookups: Lookups,
  inputs: ActionInput[],
): Promise<RuleActionEntity[]> {
  if (inputs.length === 0 || inputs.length > MAX_ACTIONS) {
    throw toolError(`give between 1 and ${MAX_ACTIONS} actions.`);
  }

  const seen = new Set<string>();
  const actions: RuleActionEntity[] = [];
  for (const [index, input] of inputs.entries()) {
    const fail = (message: string): never => {
      throw toolError(`actions[${index}]: ${message}`);
    };
    if (input.value.trim() === '') fail('value must not be empty.');

    if (input.op === 'set') {
      const { field } = input;
      if (!field) fail('set needs a field: category, payee or notes.');
      if (seen.has(`set:${field}`)) {
        fail(`there is already an action that sets ${field}.`);
      }
      seen.add(`set:${field}`);
      if (field === 'category') {
        actions.push({
          op: 'set',
          field,
          value: (await lookups.category(input.value)).id,
        });
      } else if (field === 'payee') {
        actions.push({
          op: 'set',
          field,
          value: (await lookups.payee(input.value)).id,
        });
      } else {
        actions.push({ op: 'set', field: 'notes', value: input.value });
      }
      continue;
    }

    if (input.field !== undefined && input.field !== 'notes') {
      fail(`${input.op} only works on the notes; leave field out.`);
    }
    actions.push({ op: input.op, value: input.value });
  }
  return actions;
}
