import type {
  ImportTransactionEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import { z } from 'zod';

import { toolError } from '#errors';

import { createLookups } from './lookup';
import type { NamedId } from './lookup';
import type { ActualApi, ActualContext } from './session';
import { loadTransactionsById } from './transaction-edits';
import type { CategoryTotal } from './transaction-edits';

/** One line of a statement, as a caller gives it. Amounts are major units. */
export type StatementRowInput = {
  date: string;
  amount: number;
  payee_name?: string | null;
  notes?: string | null;
  imported_id?: string | null;
  /** A category name or id. */
  category?: string | null;
};

export type PreparedRow = {
  /** Where the row stood in the list the caller sent, counting from 1. */
  position: number;
  date: string;
  /** Major units, signed. */
  amount: number;
  /** The same amount in the integer minor units Actual stores. */
  minor: number;
  payee_name: string | null;
  notes: string | null;
  imported_id: string | null;
  category: NamedId | null;
};

export type StatementAccount = NamedId & { offBudget: boolean };

function blankToNull(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/** An account from its id or exact name. A closed account is refused unless `allowClosed`. */
export async function loadStatementAccount(
  ctx: ActualContext,
  text: string,
  { allowClosed = false }: { allowClosed?: boolean } = {},
): Promise<StatementAccount> {
  const { id, name } = await createLookups(ctx).account(text);
  const account = (await ctx.api.getAccounts()).find(item => item.id === id);
  if (!account) throw toolError(`unknown account "${text}".`);
  if (account.closed && !allowClosed) {
    throw toolError(
      `account "${name}" is closed. Statements can only be imported into an open account; list_accounts shows which are open.`,
    );
  }
  return { id, name, offBudget: Boolean(account.offbudget) };
}

function describePositions(positions: number[]): string {
  const shown = positions.slice(0, 5).join(', ');
  return positions.length > 5 ? `${shown}, ...` : shown;
}

/**
 * Checks the rows and turns them into what the import needs. Everything wrong
 * is reported before anything is done, naming the rows, because a statement is
 * all-or-nothing: a half-imported one is hard to untangle.
 */
export async function prepareRows(
  ctx: ActualContext,
  account: StatementAccount,
  rows: StatementRowInput[],
): Promise<PreparedRow[]> {
  const { decimalPlaces, toMinor } = ctx.amounts;
  const scale = 10 ** decimalPlaces;
  const lookups = createLookups(ctx);
  const categories = new Map<string, NamedId>();

  const prepared: PreparedRow[] = [];
  for (const [index, row] of rows.entries()) {
    const position = index + 1;
    if (!Number.isFinite(row.amount)) {
      throw toolError(`row ${position}: the amount is not a number.`);
    }
    const scaled = row.amount * scale;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      throw toolError(
        `row ${position}: the amount ${row.amount} has more than ${decimalPlaces} decimal places, which this budget's currency cannot hold.`,
      );
    }

    let category: NamedId | null = null;
    const categoryText = blankToNull(row.category);
    if (categoryText) {
      const key = categoryText.toLowerCase();
      let found = categories.get(key);
      if (!found) {
        try {
          found = await lookups.category(categoryText);
        } catch (error) {
          throw toolError(
            `row ${position}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        categories.set(key, found);
      }
      category = found;
    }

    prepared.push({
      position,
      date: row.date,
      amount: Number(row.amount.toFixed(decimalPlaces)),
      minor: toMinor(row.amount),
      payee_name: blankToNull(row.payee_name),
      notes: blankToNull(row.notes),
      imported_id: blankToNull(row.imported_id),
      category,
    });
  }

  const withCategory = prepared.filter(row => row.category);
  if (account.offBudget && withCategory.length > 0) {
    throw toolError(
      `${withCategory.length} row(s) (${describePositions(withCategory.map(row => row.position))}) have a category, but "${account.name}" is an off-budget account, which has no categories. Leave category out.`,
    );
  }

  // An imported_id is how a re-import recognises a transaction. Two rows with
  // the same one would be added twice now and then be indistinguishable.
  const firstWith = new Map<string, number>();
  for (const row of prepared) {
    if (!row.imported_id) continue;
    const earlier = firstWith.get(row.imported_id);
    if (earlier !== undefined) {
      throw toolError(
        `imported_id "${row.imported_id}" is on both row ${earlier} and row ${row.position}. Each imported_id must be unique within one call: make them unique (for example by adding the date and amount), or leave imported_id out of those rows so they are matched on date and amount instead.`,
      );
    }
    firstWith.set(row.imported_id, row.position);
  }

  return prepared;
}

export type RowStatus = 'new' | 'duplicate' | 'updated';

/** The existing transaction a row matched, when importing would change it. */
export type ExistingMatch = {
  id: string;
  date: string;
  payee: string | null;
};

export type ClassifiedRow = {
  row: PreparedRow;
  status: RowStatus;
  existing: ExistingMatch | null;
  /** For an updated row: what the import fills in on the existing transaction. */
  fills: string[];
};

export type ImportClassification = {
  rows: ClassifiedRow[];
  newCount: number;
  duplicateCount: number;
  updatedCount: number;
};

type ImportResult = Awaited<ReturnType<ActualApi['importTransactions']>>;

function toImportEntity(
  accountId: string,
  row: PreparedRow,
): ImportTransactionEntity {
  return {
    account: accountId,
    date: row.date,
    amount: row.minor,
    ...(row.payee_name ? { payee_name: row.payee_name } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.imported_id ? { imported_id: row.imported_id } : {}),
    ...(row.category ? { category: row.category.id } : {}),
  };
}

function throwOnImportErrors({ errors }: ImportResult) {
  if (errors.length > 0) {
    throw toolError(
      `Actual refused the rows: ${errors.map(error => error.message).join('; ')}. Nothing was imported.`,
    );
  }
}

// What the update of a matched transaction changes, from the same rules the
// import follows: fields the transaction already has are kept, and missing
// ones are filled from the row.
function fieldsFilled(
  existing: TransactionEntity,
  incoming: TransactionEntity,
): string[] {
  const fills: string[] = [];
  if ((incoming.imported_id || null) !== (existing.imported_id || null)) {
    fills.push('imported_id');
  }
  if ((incoming.imported_payee || null) !== (existing.imported_payee || null)) {
    fills.push('imported_payee');
  }
  if (!existing.payee && incoming.payee) fills.push('payee');
  if (!existing.category && incoming.category) fills.push('category');
  if (!existing.notes && incoming.notes) fills.push('notes');
  if (!existing.cleared && incoming.cleared) fills.push('cleared');
  return fills;
}

const markerSchema = z.object({ trx_id: z.string() });

/**
 * Asks Actual what importing the rows would do, without doing it. This is
 * Actual's own dry run, so the answer is exactly what the real import does,
 * including how it matches rows to existing transactions and which rules run.
 *
 * Actual's results only list the rows that matched something, in no way tied
 * to the row they came from, so each row carries a marker that survives into
 * its result (the same trick Actual's own import screen uses).
 */
export async function classifyRows(
  ctx: ActualContext,
  account: StatementAccount,
  rows: PreparedRow[],
): Promise<ImportClassification> {
  const result = await ctx.api.importTransactions(
    account.id,
    rows.map((row, index) => ({
      ...toImportEntity(account.id, row),
      trx_id: String(index),
    })),
    { dryRun: true },
  );
  throwOnImportErrors(result);

  const matches = new Map<number, ImportResult['updatedPreview'][number]>();
  for (const entry of result.updatedPreview) {
    const marker = markerSchema.safeParse(entry.transaction);
    if (!marker.success) {
      throw new Error(
        "Actual's import preview did not say which row each result belongs to",
      );
    }
    matches.set(Number(marker.data.trx_id), entry);
  }

  const classified = rows.map((row, index): ClassifiedRow => {
    const match = matches.get(index);
    if (!match) return { row, status: 'new', existing: null, fills: [] };
    const { existing } = match;
    if (!existing) {
      return { row, status: 'duplicate', existing: null, fills: [] };
    }
    return {
      row,
      status: 'updated',
      existing: {
        id: existing.id,
        date: existing.date,
        // The preview adds the payee's name to the matched transaction.
        payee:
          z.object({ payee_name: z.string().nullish() }).parse(existing)
            .payee_name ?? null,
      },
      fills: fieldsFilled(existing, match.transaction),
    };
  });

  const count = (status: RowStatus) =>
    classified.filter(entry => entry.status === status).length;
  const classification = {
    rows: classified,
    newCount: count('new'),
    duplicateCount: count('duplicate'),
    updatedCount: count('updated'),
  };
  if (classification.newCount !== result.added.length) {
    throw new Error(
      `Actual's import preview adds ${result.added.length} transactions but ${classification.newCount} rows were classed as new`,
    );
  }
  return classification;
}

export type ImportOutcome = {
  added_count: number;
  updated_count: number;
  /** The added transactions, by the category the budget's rules gave them. */
  by_category: CategoryTotal[];
  uncategorized: { count: number; total_amount: number };
  samples: {
    id: string;
    date: string;
    amount: number;
    payee: string | null;
    category: string | null;
  }[];
  warnings: string[];
};

/**
 * Imports the rows for real, then reads the new transactions back to report
 * what the budget's rules made of them.
 */
export async function importRows(
  ctx: ActualContext,
  account: StatementAccount,
  rows: PreparedRow[],
  expected: ImportClassification,
  { maxSamples }: { maxSamples: number },
): Promise<ImportOutcome> {
  const result = await ctx.api.importTransactions(
    account.id,
    rows.map(row => toImportEntity(account.id, row)),
    { dryRun: false },
  );
  throwOnImportErrors(result);

  const warnings: string[] = [];
  if (result.added.length !== expected.newCount) {
    warnings.push(
      `The preview expected ${expected.newCount} new transactions but Actual added ${result.added.length}. Check the account with get_transactions.`,
    );
  }

  const found = new Map(
    (await loadTransactionsById(ctx, result.added)).map(transaction => [
      transaction.id,
      transaction,
    ]),
  );
  // Back in the order the rows were given.
  const added = result.added.flatMap(id => found.get(id) ?? []);
  if (added.length !== result.added.length) {
    warnings.push(
      `${result.added.length - added.length} added transaction(s) could not be read back; check the account with get_transactions.`,
    );
  }

  const { toMajor, toMinor } = ctx.amounts;
  const totals = new Map<string, CategoryTotal & { minor: number }>();
  let uncategorized = { count: 0, minor: 0 };
  for (const transaction of added) {
    const minor = toMinor(transaction.amount);
    if (!transaction.category_id || !transaction.category) {
      uncategorized = {
        count: uncategorized.count + 1,
        minor: uncategorized.minor + minor,
      };
      continue;
    }
    const entry = totals.get(transaction.category_id) ?? {
      category_id: transaction.category_id,
      category: transaction.category,
      count: 0,
      total_amount: 0,
      minor: 0,
    };
    entry.count++;
    entry.minor += minor;
    totals.set(transaction.category_id, entry);
  }

  return {
    added_count: result.added.length,
    updated_count: result.updated.length,
    by_category: [...totals.values()]
      .map(({ minor, ...entry }) => ({
        ...entry,
        total_amount: toMajor(minor),
      }))
      .sort((a, b) => b.count - a.count),
    uncategorized: {
      count: uncategorized.count,
      total_amount: toMajor(uncategorized.minor),
    },
    samples: added.slice(0, maxSamples).map(transaction => ({
      id: transaction.id,
      date: transaction.date,
      amount: transaction.amount,
      payee: transaction.payee,
      category: transaction.category,
    })),
    warnings,
  };
}
