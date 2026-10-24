import { z } from 'zod';

import {
  ACTION_FIELDS,
  ACTION_OPS,
  CONDITION_FIELDS,
  CONDITION_OPS,
  MAX_ACTIONS,
  MAX_CONDITIONS,
} from '#actual/rule-input';
import type { ActionInput, ConditionInput } from '#actual/rule-input';
import type { RuleMatches } from '#actual/rule-matches';
import { transactionRowSchema } from '#actual/transactions';

export const CONDITIONS_HELP = `A list of 1-${MAX_CONDITIONS} conditions, each { field, op, value }. Supported fields and operators: payee (is, isNot, oneOf, notOneOf; value is a payee name or id, or a list of them for oneOf/notOneOf); imported_payee, the description the bank sent (is, isNot, oneOf, notOneOf, contains, doesNotContain, matches; value is text, or a list for oneOf/notOneOf); notes (is, isNot, contains, doesNotContain, matches; value is text); amount (is, isapprox, gt, gte, lt, lte, isbetween; value is a number in major currency units, e.g. dollars, signed: spending is negative, so "over 100 spent" is { "field": "amount", "op": "lt", "value": -100 }; isbetween takes { "num1": -50, "num2": -10 }); date (is, gt, gte, lt, lte; value is YYYY-MM-DD); category and account (is, isNot, oneOf, notOneOf; value is a name or id, or a list; category also accepts null for "no category yet", e.g. to leave transactions that were categorized by hand alone). Text comparisons ignore case; matches is a regular expression and must be written in lowercase. Other fields and operators (for example "payee contains") are not supported, because the preview could not show exactly what the rule does.`;

export const ACTIONS_HELP = `A list of 1-${MAX_ACTIONS} actions: { "op": "set", "field": "category", "value": "Groceries" } sets the category (a name or id); { "op": "set", "field": "payee", "value": "Costco" } sets the payee (an existing payee's name or id); { "op": "set", "field": "notes", "value": "..." } replaces the notes; { "op": "append-notes", "value": " [x]" } and { "op": "prepend-notes", "value": "..." } add text to the notes. Other kinds of action (splits, linking a schedule, templates, deleting) are not supported.`;

export const conditionSchema = z.object({
  field: z.enum(CONDITION_FIELDS),
  op: z.enum(CONDITION_OPS),
  value: z.union([
    z.string(),
    z.number(),
    z.array(z.string()),
    z.object({ num1: z.number(), num2: z.number() }),
    z.null(),
  ]),
}) satisfies z.ZodType<ConditionInput>;

export const actionSchema = z.object({
  op: z.enum(ACTION_OPS),
  field: z.enum(ACTION_FIELDS).optional(),
  value: z.string(),
}) satisfies z.ZodType<ActionInput>;

export const matchField = z
  .enum(['all', 'any'])
  .default('all')
  .describe(
    '"all": a transaction must meet every condition (the default). "any": meeting one is enough.',
  );

// A default would apply even when the field is optional, and silently turn an
// "any" rule into an "all" rule on any other change.
export const optionalMatchField = z
  .enum(['all', 'any'])
  .optional()
  .describe(
    '"all": a transaction must meet every condition. "any": meeting one is enough. Omit to keep the rule as it is.',
  );

export const stageField = z
  .enum(['pre', 'default', 'post'])
  .default('default')
  .describe(
    'When the rule runs relative to others: pre, then default, then post. Almost always default.',
  );

export const ruleBodyShape = {
  stage: z
    .enum(['pre', 'default', 'post'])
    .describe('Rules run in three passes: pre, then default, then post.'),
  match: z
    .enum(['all', 'any'])
    .describe('"all": every condition must match; "any": one is enough.'),
  conditions: z.array(
    z.object({
      field: z.string(),
      op: z.string(),
      value: z.unknown().describe('The stored value; amounts in major units.'),
      value_text: z.string().describe('The value with ids replaced by names.'),
    }),
  ),
  actions: z.array(
    z.object({
      op: z.string(),
      field: z.string().nullable(),
      value: z.unknown(),
      value_text: z.string(),
    }),
  ),
  summary: z.string().describe('The whole rule in one sentence.'),
};

export const ruleBodySchema = z.object(ruleBodyShape);

export const ruleMatchesSchema = z.object({
  total_count: z
    .number()
    .describe('Existing transactions that meet the conditions.'),
  total_amount: z
    .number()
    .describe('Net sum of all of them, major units, signed.'),
  by_category: z
    .array(
      z.object({
        category_id: z.string().nullable(),
        category: z
          .string()
          .nullable()
          .describe('Null: these have no category.'),
        count: z.number(),
        total_amount: z.number().describe('Major units, signed.'),
      }),
    )
    .describe(
      'How those transactions are categorized today, most common first.',
    ),
  transactions: z.array(transactionRowSchema).describe('The newest matches.'),
  has_more: z.boolean().describe('Whether more than the listed ones match.'),
});

/** The matches as lines of text, for clients that only show the model `content`. */
export function describeMatches(
  matches: RuleMatches,
  format: (amount: number) => string,
): string[] {
  if (matches.total_count === 0) {
    return ['No existing transactions match.'];
  }
  const categories = matches.by_category
    .map(entry => `${entry.category ?? '(uncategorized)'} ${entry.count}`)
    .join(', ');
  return [
    `${matches.total_count} existing transaction(s) match, net ${format(matches.total_amount)}. Their categories today: ${categories}.`,
    ...matches.transactions.map(transaction =>
      [
        transaction.date,
        format(transaction.amount),
        transaction.payee ?? '(no payee)',
        transaction.category ??
          (transaction.is_transfer ? '(transfer)' : '(uncategorized)'),
        transaction.account ?? '',
        `[id: ${transaction.id}]`,
      ].join(' | '),
    ),
    ...(matches.has_more
      ? [`... and ${matches.total_count - matches.transactions.length} more.`]
      : []),
  ];
}
