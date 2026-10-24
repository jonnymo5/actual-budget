import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import type { NamedId } from '#actual/lookup';
import {
  applyEdits,
  loadTransactionsById,
  MAX_SAMPLES,
  planEdit,
  reconciledWarning,
  toSample,
  totalByNewCategory,
} from '#actual/transaction-edits';
import type { PlannedEdit } from '#actual/transaction-edits';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { categoryTotalSchema, editSampleSchema } from '#tools/schemas';

const MAX_ASSIGNMENTS = 500;
const MAX_LISTED_IDS = 10;

export const categorizeTransactions = defineTool({
  name: 'categorize_transactions',
  title: 'Categorize transactions',
  description: `Set the category of many transactions at once: pass a list of { transaction_id, category } (up to ${MAX_ASSIGNMENTS}), where category is a category name or id. Get ids from get_uncategorized or get_transactions. The preview lists what changes (newest ${MAX_SAMPLES} in full, the rest counted) with each transaction's old and new category, the total per new category (net sums in major currency units, e.g. dollars, not cents), and any transaction that is skipped and why: transfers between accounts, off-budget (tracking) accounts and the summary line of a split cannot be categorized. Transactions that already have the category are left alone. If any transaction id or category name is unknown the whole call fails and nothing is changed, so a typo never gives a half-finished result. To categorize future transactions automatically, create a rule with create_rule.`,
  kind: 'write',
  input: {
    assignments: z
      .array(
        z.object({
          transaction_id: z
            .string()
            .min(1)
            .describe(
              'A transaction id from get_uncategorized or get_transactions.',
            ),
          category: z
            .string()
            .min(1)
            .describe('A category name (case-insensitive) or id.'),
        }),
      )
      .min(1)
      .max(MAX_ASSIGNMENTS)
      .describe('The transactions and the category each should get.'),
  },
  output: {
    requested: z.number().describe('How many assignments were given.'),
    change_count: z
      .number()
      .describe('Transactions that change (dry run: would change).'),
    unchanged_count: z
      .number()
      .describe('Transactions that already have the requested category.'),
    skipped: z.array(
      z.object({
        transaction_id: z.string(),
        reason: z.string().describe('Why it cannot be categorized.'),
      }),
    ),
    by_category: z
      .array(categoryTotalSchema)
      .describe('The transactions that change, per new category.'),
    samples: z
      .array(editSampleSchema)
      .describe(`The first ${MAX_SAMPLES} changes, with old and new category.`),
    warnings: z.array(z.string()),
  },
  async handler({ assignments }, ctx) {
    const lookups = createLookups(ctx);

    const seen = new Set<string>();
    for (const { transaction_id } of assignments) {
      if (seen.has(transaction_id)) {
        throw toolError(
          `transaction_id "${transaction_id}" appears more than once. Give each transaction one category.`,
        );
      }
      seen.add(transaction_id);
    }

    const categories = new Map<string, NamedId>();
    for (const { category } of assignments) {
      const key = category.trim().toLowerCase();
      if (!categories.has(key)) {
        categories.set(key, await lookups.category(category));
      }
    }

    const transactions = new Map(
      (await loadTransactionsById(ctx, [...seen])).map(transaction => [
        transaction.id,
        transaction,
      ]),
    );
    const unknown = [...seen].filter(id => !transactions.has(id));
    if (unknown.length > 0) {
      const listed = unknown.slice(0, MAX_LISTED_IDS).join(', ');
      throw toolError(
        `${unknown.length} transaction_id value(s) are not transactions in this budget: ${listed}${unknown.length > MAX_LISTED_IDS ? ', ...' : ''}. Nothing was changed; get ids from get_uncategorized or get_transactions.`,
      );
    }

    const edits: PlannedEdit[] = [];
    const skipped: { transaction_id: string; reason: string }[] = [];
    let unchanged = 0;
    for (const { transaction_id, category } of assignments) {
      const transaction = transactions.get(transaction_id);
      const target = categories.get(category.trim().toLowerCase());
      if (!transaction || !target) continue;
      const plan = planEdit(transaction, { category: target });
      if (plan.kind === 'change') edits.push(plan.edit);
      else if (plan.kind === 'unchanged') unchanged++;
      else skipped.push({ transaction_id, reason: plan.reason });
    }

    if (!ctx.dryRun) await applyEdits(ctx, edits);

    const byCategory = totalByNewCategory(ctx, edits);
    const data = {
      requested: assignments.length,
      change_count: edits.length,
      unchanged_count: unchanged,
      skipped,
      by_category: byCategory,
      samples: edits.slice(0, MAX_SAMPLES).map(toSample),
      warnings: reconciledWarning(edits),
    };

    const { format } = ctx.amounts;
    const verb = ctx.dryRun ? 'Would categorize' : 'Categorized';
    const lines = [
      `${verb} ${edits.length} of ${assignments.length} transaction(s); ${unchanged} already had that category${skipped.length > 0 ? `; ${skipped.length} skipped` : ''}.`,
      ...byCategory.map(
        entry =>
          `  ${entry.category}: ${entry.count} transaction(s), net ${format(entry.total_amount)}`,
      ),
      ...data.samples.map(sample => {
        const change = sample.changes[0];
        return `  ${sample.date} | ${format(sample.amount)} | ${sample.payee ?? '(no payee)'}: ${change?.from ?? '(uncategorized)'} -> ${change?.to} [id: ${sample.id}]`;
      }),
      ...(edits.length > MAX_SAMPLES
        ? [`  ... and ${edits.length - MAX_SAMPLES} more.`]
        : []),
      ...skipped.map(
        entry => `  Skipped ${entry.transaction_id}: ${entry.reason}.`,
      ),
      ...data.warnings,
    ];
    return { data, text: lines.join('\n') };
  },
});
