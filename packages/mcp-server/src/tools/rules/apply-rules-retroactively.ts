import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import { buildMatchQuery, lookUpMatches } from '#actual/rule-matches';
import { loadRule } from '#actual/rules';
import {
  appendToNotes,
  applyEdits,
  loadMatchedTransactions,
  MAX_SAMPLES,
  planEdit,
  prependToNotes,
  reconciledWarning,
  toSample,
  totalByNewCategory,
} from '#actual/transaction-edits';
import type {
  EditableTransaction,
  PlannedEdit,
  WantedEdit,
} from '#actual/transaction-edits';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { categoryTotalSchema, editSampleSchema, isoDate } from '#tools/schemas';

import { ruleBodySchema } from './rule-schemas';

const MAX_TRANSACTIONS = 2000;

type StoredAction = {
  op: string;
  field?: string | null;
  value?: unknown;
  options?: unknown;
};

// What the rule does to each transaction, in the terms the edit planner knows.
// Anything else the engine supports (templates, formulas, splits, deleting) is
// refused rather than approximated.
type Step =
  | { kind: 'category' | 'payee'; id: string }
  | { kind: 'notes'; text: string }
  | { kind: 'append' | 'prepend'; text: string };

function toStep(action: StoredAction): Step | null {
  if (typeof action.value !== 'string') return null;
  if (action.op === 'append-notes') {
    return { kind: 'append', text: action.value };
  }
  if (action.op === 'prepend-notes') {
    return { kind: 'prepend', text: action.value };
  }
  if (action.op !== 'set' || action.options) return null;
  if (action.field === 'category' || action.field === 'payee') {
    return { kind: action.field, id: action.value };
  }
  if (action.field === 'notes') return { kind: 'notes', text: action.value };
  return null;
}

export const applyRulesRetroactively = defineTool({
  name: 'apply_rules_retroactively',
  title: 'Apply a rule to existing transactions',
  description: `Run an existing rule's actions over the transactions that already exist and match its conditions (rules otherwise only act on new and imported transactions). Only rules whose actions set the category, payee or notes, or add text to the notes, can be applied this way; for any other rule the call fails and nothing changes. By default a category, payee or note that is already filled in is left alone, so transactions you categorized by hand keep their category; pass overwrite true to replace them. Added text is not added twice. The preview shows how many transactions match, how many change, how many already have the right values or were left alone, any that are skipped and why (transfers, off-budget accounts and the summary line of a split cannot be categorized), the total per new category, and the first ${MAX_SAMPLES} changes with old and new values. At most ${MAX_TRANSACTIONS} transactions are handled per call; narrow with start_date and end_date for more. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD. Find rule ids with get_rules; preview_rule shows what conditions match before a rule exists.`,
  kind: 'write',
  input: {
    rule_id: z
      .string()
      .min(1)
      .describe('The rule to apply (id from get_rules).'),
    start_date: isoDate
      .optional()
      .describe('Only transactions on or after this day, YYYY-MM-DD.'),
    end_date: isoDate
      .optional()
      .describe('Only transactions on or before this day, YYYY-MM-DD.'),
    overwrite: z
      .boolean()
      .default(false)
      .describe(
        'Also replace a category, payee or note that is already filled in. Off by default.',
      ),
  },
  output: {
    rule: ruleBodySchema,
    matched_count: z
      .number()
      .describe("Existing transactions that meet the rule's conditions."),
    change_count: z
      .number()
      .describe('Transactions that change (dry run: would change).'),
    unchanged_count: z
      .number()
      .describe('Matches that already have what the rule would set.'),
    left_alone_count: z
      .number()
      .describe(
        'Matches that already have a value and were kept because overwrite is false.',
      ),
    skipped: z.array(
      z.object({
        reason: z.string(),
        count: z.number(),
      }),
    ),
    by_category: z.array(categoryTotalSchema),
    samples: z.array(editSampleSchema),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    if (
      input.start_date &&
      input.end_date &&
      input.start_date > input.end_date
    ) {
      throw toolError(
        `start_date (${input.start_date}) must not be after end_date (${input.end_date}).`,
      );
    }

    const { stored, summary } = await loadRule(ctx, input.rule_id);
    const { id: _id, ...rule } = summary;

    const steps: Step[] = [];
    for (const action of stored.actions) {
      const step = toStep(action);
      if (!step) {
        throw toolError(
          `rule ${input.rule_id} has an action (${action.op}${'field' in action && action.field ? ` ${action.field}` : ''}) that this tool cannot preview exactly, so it will not apply it. Only setting the category, payee or notes and adding to the notes are supported; apply this rule from Actual's rules screen instead.`,
        );
      }
      steps.push(step);
    }

    const lookups = createLookups(ctx);
    const category = steps.find(step => step.kind === 'category');
    const payee = steps.find(step => step.kind === 'payee');
    const categoryTarget =
      category && 'id' in category
        ? await lookups.category(category.id)
        : undefined;
    const payeeTarget =
      payee && 'id' in payee ? await lookups.payee(payee.id) : undefined;
    const noteSteps = steps.filter(step => 'text' in step);

    const matching = await buildMatchQuery(ctx, {
      conditions: stored.conditions,
      match: stored.conditionsOp === 'or' ? 'any' : 'all',
      startDate: input.start_date,
      endDate: input.end_date,
    });
    const matched = await lookUpMatches(() =>
      loadMatchedTransactions(ctx, matching, { max: MAX_TRANSACTIONS }),
    );

    const wantedFor = (transaction: EditableTransaction): WantedEdit => {
      const wanted: WantedEdit = {};
      if (categoryTarget && (input.overwrite || !transaction.category_id)) {
        wanted.category = categoryTarget;
      }
      if (payeeTarget && (input.overwrite || !transaction.payee_id)) {
        wanted.payee = payeeTarget;
      }
      const writesNotes = noteSteps.some(step => step.kind === 'notes');
      if (
        noteSteps.length > 0 &&
        (input.overwrite || !writesNotes || !transaction.notes)
      ) {
        wanted.notes = current =>
          noteSteps.reduce<string | null>((notes, step) => {
            if (step.kind === 'append') {
              return appendToNotes(step.text)(notes);
            }
            if (step.kind === 'prepend') {
              return prependToNotes(step.text)(notes);
            }
            return step.text;
          }, current);
      }
      return wanted;
    };

    const edits: PlannedEdit[] = [];
    const skipped = new Map<string, number>();
    let unchanged = 0;
    let leftAlone = 0;
    for (const transaction of matched) {
      const wanted = wantedFor(transaction);
      if (!wanted.category && !wanted.payee && !wanted.notes) {
        leftAlone++;
        continue;
      }
      const plan = planEdit(transaction, wanted);
      if (plan.kind === 'change') edits.push(plan.edit);
      else if (plan.kind === 'unchanged') unchanged++;
      else skipped.set(plan.reason, (skipped.get(plan.reason) ?? 0) + 1);
    }

    if (!ctx.dryRun) await applyEdits(ctx, edits);

    const data = {
      rule,
      matched_count: matched.length,
      change_count: edits.length,
      unchanged_count: unchanged,
      left_alone_count: leftAlone,
      skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
      by_category: totalByNewCategory(ctx, edits),
      samples: edits.slice(0, MAX_SAMPLES).map(toSample),
      warnings: reconciledWarning(edits),
    };

    const { format } = ctx.amounts;
    const text = [
      `Rule: ${rule.summary}`,
      `${matched.length} existing transaction(s) match. ${ctx.dryRun ? 'Would change' : 'Changed'} ${edits.length}; ${unchanged} already as the rule sets them; ${leftAlone} left alone because they already have a value${input.overwrite ? '' : ' (overwrite is false)'}.`,
      ...data.skipped.map(
        entry => `  Skipped ${entry.count}: ${entry.reason}.`,
      ),
      ...data.by_category.map(
        entry =>
          `  -> ${entry.category}: ${entry.count} transaction(s), net ${format(entry.total_amount)}`,
      ),
      ...data.samples.map(
        sample =>
          `  ${sample.date} | ${format(sample.amount)} | ${sample.payee ?? '(no payee)'}: ${sample.changes.map(change => `${change.field} ${change.from ?? '(empty)'} -> ${change.to ?? '(empty)'}`).join('; ')} [id: ${sample.id}]`,
      ),
      ...(edits.length > MAX_SAMPLES
        ? [`  ... and ${edits.length - MAX_SAMPLES} more.`]
        : []),
      ...data.warnings,
    ].join('\n');
    return { data, text };
  },
});
