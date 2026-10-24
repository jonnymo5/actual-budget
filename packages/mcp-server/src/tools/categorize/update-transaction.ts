import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import {
  applyEdits,
  loadTransactionsById,
  planEdit,
  reconciledWarning,
  toSample,
} from '#actual/transaction-edits';
import type { WantedEdit } from '#actual/transaction-edits';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { editSampleSchema } from '#tools/schemas';

export const updateTransaction = defineTool({
  name: 'update_transaction',
  title: 'Edit a transaction',
  description:
    "Change one transaction's category, payee or notes; give only the fields to change. The category is a category name or id, the payee an existing payee's name or id (get_payees finds it; this tool does not create payees), and notes replaces the whole note (an empty string clears it). The date, amount and account cannot be changed, and split transactions are not supported. A transfer between accounts can only have its notes changed. The preview shows the old and new value of each field; amounts are in major currency units (e.g. dollars, not cents) and dates are YYYY-MM-DD. To categorize many transactions use categorize_transactions.",
  kind: 'write',
  input: {
    transaction_id: z
      .string()
      .min(1)
      .describe('The transaction to change (id from get_transactions).'),
    category: z
      .string()
      .min(1)
      .optional()
      .describe('A category name (case-insensitive) or id.'),
    payee: z
      .string()
      .min(1)
      .optional()
      .describe('An existing payee name (case-insensitive) or id.'),
    notes: z
      .string()
      .optional()
      .describe(
        'The new notes, replacing the old. An empty string clears them.',
      ),
  },
  output: {
    changed: z
      .boolean()
      .describe('Whether anything differs from what the transaction has now.'),
    transaction: editSampleSchema.describe(
      'The transaction and the change to each field (empty when nothing differs).',
    ),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    if (
      input.category === undefined &&
      input.payee === undefined &&
      input.notes === undefined
    ) {
      throw toolError(
        'give at least one of category, payee or notes to change.',
      );
    }

    const [transaction] = await loadTransactionsById(ctx, [
      input.transaction_id,
    ]);
    if (!transaction) {
      throw toolError(
        `unknown transaction_id "${input.transaction_id}". Get ids from get_transactions.`,
      );
    }

    const lookups = createLookups(ctx);
    const { notes } = input;
    const wanted: WantedEdit = {
      category:
        input.category === undefined
          ? undefined
          : await lookups.category(input.category),
      payee:
        input.payee === undefined
          ? undefined
          : await lookups.payee(input.payee),
      notes: notes === undefined ? undefined : () => notes,
    };

    const plan = planEdit(transaction, wanted);
    if (plan.kind === 'skip') {
      throw toolError(
        `transaction ${transaction.id} cannot be changed that way: it is ${plan.reason}.`,
      );
    }
    if (plan.kind === 'unchanged') {
      return {
        data: {
          changed: false,
          transaction: toSample({
            transaction,
            changes: [],
            fields: {},
            category: undefined,
          }),
          warnings: [],
        },
        text: 'Nothing to change: the transaction already has those values.',
      };
    }

    if (!ctx.dryRun) await applyEdits(ctx, [plan.edit]);

    const sample = toSample(plan.edit);
    const { format } = ctx.amounts;
    const text = [
      `${ctx.dryRun ? 'Would change' : 'Changed'} ${sample.date} | ${format(sample.amount)} | ${sample.payee ?? '(no payee)'} [id: ${sample.id}]`,
      ...sample.changes.map(
        change =>
          `  ${change.field}: ${change.from ?? '(empty)'} -> ${change.to ?? '(empty)'}`,
      ),
    ].join('\n');
    return {
      data: {
        changed: true,
        transaction: sample,
        warnings: reconciledWarning([plan.edit]),
      },
      text,
    };
  },
});
