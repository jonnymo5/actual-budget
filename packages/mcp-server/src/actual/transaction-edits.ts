import { z } from 'zod';

import { toolError } from '#errors';

import type { NamedId } from './lookup';
import { queryRows } from './query';
import type { AqlQuery } from './query';
import type { ActualContext } from './session';
import { ID_SHAPED } from './transactions';

// What an edit needs to know about a transaction, as ActualQL returns it.
const EDIT_FIELDS = [
  'id',
  'date',
  'amount',
  'account',
  'account.name',
  'account.offbudget',
  'payee',
  'payee.name',
  'category',
  'category.name',
  'notes',
  'transfer_id',
  'is_parent',
  'reconciled',
];

const rowSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  account: z.string(),
  'account.name': z.string().nullable(),
  'account.offbudget': z.boolean().nullable(),
  payee: z.string().nullable(),
  'payee.name': z.string().nullable(),
  category: z.string().nullable(),
  'category.name': z.string().nullable(),
  notes: z.string().nullable(),
  transfer_id: z.string().nullable(),
  is_parent: z.boolean().nullable(),
  reconciled: z.boolean().nullable(),
});

export type EditableTransaction = {
  id: string;
  date: string;
  /** Major units, signed. */
  amount: number;
  account: string | null;
  account_off_budget: boolean;
  payee_id: string | null;
  payee: string | null;
  category_id: string | null;
  category: string | null;
  notes: string | null;
  is_transfer: boolean;
  /** The summary line of a split transaction; its split lines are separate rows. */
  is_split_parent: boolean;
  /** Reconciled transactions are locked in Actual's own screens. */
  reconciled: boolean;
};

function toEditable(
  ctx: ActualContext,
  row: z.output<typeof rowSchema>,
): EditableTransaction {
  return {
    id: row.id,
    date: row.date,
    amount: ctx.amounts.toMajor(row.amount),
    account: row['account.name'],
    account_off_budget: Boolean(row['account.offbudget']),
    payee_id: row.payee,
    payee: row['payee.name'],
    category_id: row.category,
    category: row['category.name'],
    notes: row.notes,
    is_transfer: row.transfer_id !== null,
    is_split_parent: Boolean(row.is_parent),
    reconciled: Boolean(row.reconciled),
  };
}

/** The transactions with these ids, in no particular order. Unknown ids are left out. */
export async function loadTransactionsById(
  ctx: ActualContext,
  ids: string[],
): Promise<EditableTransaction[]> {
  // ActualQL inlines the values of an id comparison, so only text that cannot
  // hold a quote may be offered to it. A real id never has one.
  const safe = ids.filter(id => ID_SHAPED.test(id));
  if (safe.length === 0) return [];
  const rows = await queryRows(
    ctx,
    ctx.api
      .q('transactions')
      .filter({ id: { $oneof: safe } })
      .select(EDIT_FIELDS)
      // Every row, split parents included, so a parent can be told apart from
      // an id that does not exist.
      .options({ splits: 'all' }),
    rowSchema,
  );
  return rows.map(row => toEditable(ctx, row));
}

/** Every row a query matches, oldest first, refusing to return more than `max`. */
export async function loadMatchedTransactions(
  ctx: ActualContext,
  matching: AqlQuery,
  { max }: { max: number },
): Promise<EditableTransaction[]> {
  const rows = await queryRows(
    ctx,
    matching
      .select(EDIT_FIELDS)
      .orderBy(['date', 'id'])
      .limit(max + 1),
    rowSchema,
  );
  if (rows.length > max) {
    throw toolError(
      `more than ${max} transactions match. Narrow it with start_date and end_date and run it again for each period.`,
    );
  }
  return rows.map(row => toEditable(ctx, row));
}

export type FieldChange = {
  field: 'category' | 'payee' | 'notes';
  from: string | null;
  to: string | null;
};

/** What to change about one transaction. Leave a field out to leave it alone. */
export type WantedEdit = {
  category?: NamedId;
  payee?: NamedId;
  /** Given the current notes, returns the new ones. */
  notes?: (current: string | null) => string | null;
};

/** The values to write, as the transaction update takes them. */
type EditFields = {
  category?: string;
  payee?: string;
  /** An empty string clears the notes. */
  notes?: string;
};

export type PlannedEdit = {
  transaction: EditableTransaction;
  changes: FieldChange[];
  fields: EditFields;
  /** The category the transaction ends up in, when the edit sets one. */
  category: NamedId | undefined;
};

export type EditPlan =
  | { kind: 'change'; edit: PlannedEdit }
  | { kind: 'unchanged' }
  | { kind: 'skip'; reason: string };

/**
 * Works out what an edit would do to one transaction, without doing it. A
 * transaction Actual does not categorise (a transfer, anything in an
 * off-budget account, the summary line of a split) is skipped with the reason.
 */
export function planEdit(
  transaction: EditableTransaction,
  wanted: WantedEdit,
): EditPlan {
  if (wanted.category || wanted.payee) {
    if (transaction.is_transfer) {
      return {
        kind: 'skip',
        reason:
          'a transfer between accounts; Actual does not give those a category or payee of their own',
      };
    }
    if (transaction.is_split_parent) {
      return {
        kind: 'skip',
        reason:
          'the summary line of a split transaction; change its split lines instead',
      };
    }
  }
  if (wanted.category && transaction.account_off_budget) {
    return {
      kind: 'skip',
      reason: 'in an off-budget account, which has no categories',
    };
  }

  const changes: FieldChange[] = [];
  const fields: EditFields = {};
  if (wanted.category && wanted.category.id !== transaction.category_id) {
    fields.category = wanted.category.id;
    changes.push({
      field: 'category',
      from: transaction.category,
      to: wanted.category.name,
    });
  }
  if (wanted.payee && wanted.payee.id !== transaction.payee_id) {
    fields.payee = wanted.payee.id;
    changes.push({
      field: 'payee',
      from: transaction.payee,
      to: wanted.payee.name,
    });
  }
  if (wanted.notes) {
    const notes = wanted.notes(transaction.notes);
    if ((notes ?? '') !== (transaction.notes ?? '')) {
      fields.notes = notes ?? '';
      changes.push({ field: 'notes', from: transaction.notes, to: notes });
    }
  }

  if (changes.length === 0) return { kind: 'unchanged' };
  return {
    kind: 'change',
    edit: { transaction, changes, fields, category: wanted.category },
  };
}

/** Text added to the end of the notes, unless the notes already end with it. */
export function appendToNotes(text: string) {
  return (current: string | null) =>
    current?.endsWith(text) ? current : `${current ?? ''}${text}`;
}

/** Text added to the start of the notes, unless the notes already start with it. */
export function prependToNotes(text: string) {
  return (current: string | null) =>
    current?.startsWith(text) ? current : `${text}${current ?? ''}`;
}

/** Applies the edits in one go, then reads them back to make sure they landed. */
export async function applyEdits(
  ctx: ActualContext,
  edits: PlannedEdit[],
): Promise<void> {
  if (edits.length === 0) return;

  await ctx.lootCore.send('transactions-batch-update', {
    updated: edits.map(edit => ({ id: edit.transaction.id, ...edit.fields })),
  });

  const after = new Map(
    (
      await loadTransactionsById(
        ctx,
        edits.map(edit => edit.transaction.id),
      )
    ).map(transaction => [transaction.id, transaction]),
  );
  const missed = edits.filter(({ transaction, fields }) => {
    const now = after.get(transaction.id);
    return (
      !now ||
      (fields.category !== undefined && now.category_id !== fields.category) ||
      (fields.payee !== undefined && now.payee_id !== fields.payee) ||
      (fields.notes !== undefined && (now.notes ?? '') !== fields.notes)
    );
  });
  if (missed.length > 0) {
    throw new Error(
      `${missed.length} of ${edits.length} transactions did not take the change (for example ${missed[0].transaction.id}). Check them with get_transactions before trying again.`,
    );
  }
}

export type EditSample = {
  id: string;
  date: string;
  /** Major units, signed. */
  amount: number;
  account: string | null;
  payee: string | null;
  changes: FieldChange[];
};

export function toSample({ transaction, changes }: PlannedEdit): EditSample {
  return {
    id: transaction.id,
    date: transaction.date,
    amount: transaction.amount,
    account: transaction.account,
    payee: transaction.payee,
    changes,
  };
}

export const MAX_SAMPLES = 20;

export type CategoryTotal = {
  category_id: string;
  category: string;
  count: number;
  /** Major units, signed. */
  total_amount: number;
};

/** How many of the edits move transactions into each category, and how much money. */
export function totalByNewCategory(
  ctx: ActualContext,
  edits: PlannedEdit[],
): CategoryTotal[] {
  const totals = new Map<string, CategoryTotal>();
  for (const { category, transaction } of edits) {
    if (!category) continue;
    const entry = totals.get(category.id) ?? {
      category_id: category.id,
      category: category.name,
      count: 0,
      total_amount: 0,
    };
    entry.count++;
    entry.total_amount += transaction.amount;
    totals.set(category.id, entry);
  }
  return [...totals.values()]
    .map(entry => ({
      ...entry,
      total_amount: Number(
        entry.total_amount.toFixed(ctx.amounts.decimalPlaces),
      ),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Tells a reader that some transactions are locked, since Actual asks before editing those. */
export function reconciledWarning(edits: PlannedEdit[]): string[] {
  const count = edits.filter(edit => edit.transaction.reconciled).length;
  return count === 0
    ? []
    : [
        `${count} of these transactions are reconciled (locked in Actual's own screens); they are changed all the same.`,
      ];
}
