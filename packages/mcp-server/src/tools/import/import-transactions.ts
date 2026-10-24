import { z } from 'zod';

import {
  classifyRows,
  importRows,
  loadStatementAccount,
  prepareRows,
} from '#actual/statement-import';
import type { ClassifiedRow, ImportOutcome } from '#actual/statement-import';
import { defineTool } from '#tools/registry';
import { categoryTotalSchema } from '#tools/schemas';

import {
  MAX_LISTED_ROWS,
  MAX_STATEMENT_ROWS,
  statementRowsSchema,
} from './statement-rows';

const sampleSchema = z.object({
  row: z.number().describe('The row, counting from 1 in the rows you sent.'),
  status: z.enum(['new', 'duplicate', 'updated']),
  date: z.string().describe('YYYY-MM-DD.'),
  amount: z.number().describe('Major units, signed.'),
  payee_name: z.string().nullable(),
  imported_id: z.string().nullable(),
  matched_transaction: z
    .object({
      id: z.string(),
      date: z.string().describe('YYYY-MM-DD.'),
      payee: z.string().nullable(),
    })
    .nullable()
    .describe('For an updated row: the existing transaction it matched.'),
  fills: z
    .array(z.string())
    .describe(
      'For an updated row: what the import fills in on the existing transaction.',
    ),
});

function toSample({ row, status, existing, fills }: ClassifiedRow) {
  return {
    row: row.position,
    status,
    date: row.date,
    amount: row.amount,
    payee_name: row.payee_name,
    imported_id: row.imported_id,
    matched_transaction: existing,
    fills,
  };
}

function describeRow(entry: ClassifiedRow, format: (amount: number) => string) {
  const { row } = entry;
  return `row ${row.position} | ${row.date} | ${format(row.amount)} | ${row.payee_name ?? '(no payee)'}`;
}

export const importTransactions = defineTool({
  name: 'import_transactions',
  title: 'Import statement transactions',
  description: `Imports statement lines into one account: pass account_id (an account id or exact name) and rows [{ date, amount, payee_name?, notes?, imported_id?, category? }] (up to ${MAX_STATEMENT_ROWS}). Dates are YYYY-MM-DD. Amounts are in major currency units (e.g. dollars, not cents) and signed: money out is negative. For OFX/QFX files, get the rows from parse_ofx; for CSV or PDF statements read the rows yourself, one per transaction, with the date, signed amount and a clean payee name. The result classifies every row the way Actual's own import does: new (will be added), duplicate (an existing transaction in the account matches, so the row is skipped) or updated (it matches an existing transaction that is missing details, which the import fills in; nothing is overwritten). A row matches an existing transaction by its imported_id, or, when either side has no imported_id, by the same amount within 7 days; so two real purchases of the same amount in one week can be mistaken for one when there is no imported_id. Check the duplicates before applying. Importing the same rows twice therefore adds nothing the second time. The budget's rules run on every new row, and the categories they assign cannot be seen in the preview; the applied result reports them, and get_uncategorized finds what is left. Payee names are tidied to title case, and by default a transaction you deleted earlier comes back if its imported_id is imported again. Transactions go in as cleared. If any row is invalid the whole call fails and nothing is imported.`,
  kind: 'write',
  input: {
    account_id: z
      .string()
      .min(1)
      .describe(
        'The account to import into: an id from list_accounts, or its exact name. It must be open.',
      ),
    rows: statementRowsSchema.describe('The statement lines to import.'),
  },
  output: {
    account: z.object({ id: z.string(), name: z.string() }),
    row_count: z.number().describe('How many rows were given.'),
    new_count: z
      .number()
      .describe('Rows added (dry run: that would be added).'),
    duplicate_count: z
      .number()
      .describe('Rows skipped because the account already has them.'),
    updated_count: z
      .number()
      .describe('Rows that fill in details on an existing transaction.'),
    duplicate_rows: z
      .array(z.number())
      .describe('The positions (from 1) of the duplicate rows.'),
    updated_rows: z
      .array(z.number())
      .describe('The positions (from 1) of the updated rows.'),
    samples: z
      .array(sampleSchema)
      .describe(
        `The first ${MAX_LISTED_ROWS} rows of each kind, in row order.`,
      ),
    applied: z
      .object({
        added_count: z.number(),
        updated_count: z.number(),
        by_category: z
          .array(categoryTotalSchema)
          .describe('The added transactions the rules categorized.'),
        uncategorized: z.object({
          count: z.number(),
          total_amount: z.number().describe('Major units, signed.'),
        }),
        samples: z.array(
          z.object({
            id: z.string(),
            date: z.string().describe('YYYY-MM-DD.'),
            amount: z.number().describe('Major units, signed.'),
            payee: z.string().nullable(),
            category: z.string().nullable(),
          }),
        ),
      })
      .nullable()
      .describe('What happened; null in a dry run.'),
    warnings: z.array(z.string()),
  },
  async handler({ account_id, rows }, ctx) {
    const account = await loadStatementAccount(ctx, account_id);
    const prepared = await prepareRows(ctx, account, rows);
    const classification = await classifyRows(ctx, account, prepared);
    const { format } = ctx.amounts;

    const warnings: string[] = [];
    const today = ctx.today();
    const future = prepared.filter(row => row.date > today);
    if (future.length > 0) {
      warnings.push(
        `${future.length} row(s) are dated after today (${today}); check the dates.`,
      );
    }
    const looseDuplicates = classification.rows.filter(
      entry => entry.status === 'duplicate' && !entry.row.imported_id,
    );
    if (looseDuplicates.length > 0) {
      warnings.push(
        `${looseDuplicates.length} duplicate row(s) have no imported_id, so they were matched only on the same amount within 7 days. Check that none is a separate purchase.`,
      );
    }

    let outcome: ImportOutcome | null = null;
    if (!ctx.dryRun) {
      outcome = await importRows(ctx, account, prepared, classification, {
        maxSamples: MAX_LISTED_ROWS,
      });
      warnings.push(...outcome.warnings);
    }

    const ofKind = (status: ClassifiedRow['status']) =>
      classification.rows.filter(entry => entry.status === status);
    const duplicates = ofKind('duplicate');
    const updated = ofKind('updated');
    const added = ofKind('new');
    const samples = [duplicates, updated, added]
      .flatMap(entries => entries.slice(0, MAX_LISTED_ROWS))
      .sort((a, b) => a.row.position - b.row.position)
      .map(toSample);

    const data = {
      account: { id: account.id, name: account.name },
      row_count: prepared.length,
      new_count: classification.newCount,
      duplicate_count: classification.duplicateCount,
      updated_count: classification.updatedCount,
      duplicate_rows: duplicates.map(entry => entry.row.position),
      updated_rows: updated.map(entry => entry.row.position),
      samples,
      applied: outcome && {
        added_count: outcome.added_count,
        updated_count: outcome.updated_count,
        by_category: outcome.by_category,
        uncategorized: outcome.uncategorized,
        samples: outcome.samples,
      },
      warnings,
    };

    const lines = [
      `${ctx.dryRun ? 'Would import' : 'Imported'} ${prepared.length} row(s) into ${account.name}: ${classification.newCount} new, ${classification.duplicateCount} duplicate (skipped), ${classification.updatedCount} updated (matched an existing transaction).`,
    ];
    const list = (
      title: string,
      entries: ClassifiedRow[],
      line: (entry: ClassifiedRow) => string,
    ) => {
      if (entries.length === 0) return;
      lines.push(`${title}:`);
      lines.push(...entries.slice(0, MAX_LISTED_ROWS).map(line));
      if (entries.length > MAX_LISTED_ROWS) {
        lines.push(`  ... and ${entries.length - MAX_LISTED_ROWS} more.`);
      }
    };
    list('Duplicates, skipped', duplicates, entry => {
      const how = entry.row.imported_id
        ? ''
        : ' (matched on amount and date only)';
      return `  ${describeRow(entry, format)}${how}`;
    });
    list('Updated existing transactions', updated, entry => {
      const match = entry.existing;
      return `  ${describeRow(entry, format)} -> existing ${match?.date} ${match?.payee ?? '(no payee)'} [id: ${match?.id}] gets ${entry.fills.join(', ') || 'new details'}`;
    });
    if (ctx.dryRun) {
      list(
        'New transactions',
        added,
        entry => `  ${describeRow(entry, format)}`,
      );
      lines.push(
        'Rules run on import and may categorize the new rows; the categories show once applied.',
      );
    }
    if (outcome) {
      const categorized = outcome.by_category.reduce(
        (sum, entry) => sum + entry.count,
        0,
      );
      lines.push(
        `The budget's rules categorized ${categorized} of the ${outcome.added_count} added transaction(s); ${outcome.uncategorized.count} are uncategorized (net ${format(outcome.uncategorized.total_amount)})${outcome.uncategorized.count > 0 ? ', which get_uncategorized lists' : ''}.`,
      );
      lines.push(
        ...outcome.by_category.map(
          entry =>
            `  ${entry.category}: ${entry.count} transaction(s), net ${format(entry.total_amount)}`,
        ),
      );
      lines.push(
        ...outcome.samples.map(
          sample =>
            `  ${sample.date} | ${format(sample.amount)} | ${sample.payee ?? '(no payee)'} | ${sample.category ?? '(uncategorized)'} [id: ${sample.id}]`,
        ),
      );
      if (outcome.added_count > outcome.samples.length) {
        lines.push(
          `  ... and ${outcome.added_count - outcome.samples.length} more.`,
        );
      }
    }
    lines.push(...warnings);
    return { data, text: lines.join('\n') };
  },
});
