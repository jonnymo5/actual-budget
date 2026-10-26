import { z } from 'zod';

import type { TransferCandidate } from '#analysis/transfers';
import { toolError } from '#errors';

import { queryRows } from './query';
import type { ActualContext } from './session';
import { ID_SHAPED } from './transactions';

const FIELDS = [
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
  'transfer_id',
  'is_parent',
  'is_child',
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
  transfer_id: z.string().nullable(),
  is_parent: z.boolean().nullable(),
  is_child: z.boolean().nullable(),
  reconciled: z.boolean().nullable(),
});

/** A transaction as the transfer tools see it, whatever state it is in. */
export type TransferSide = TransferCandidate & {
  payee_id: string | null;
  /** True once the transaction is one side of a transfer. */
  is_transfer: boolean;
  /** Part of a split transaction (the summary line or one of its lines). */
  is_split: boolean;
  /** Reconciled transactions are locked in Actual's own screens. */
  reconciled: boolean;
};

function toSide(row: z.output<typeof rowSchema>): TransferSide {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    account_id: row.account,
    account: row['account.name'],
    account_off_budget: Boolean(row['account.offbudget']),
    payee_id: row.payee,
    payee: row['payee.name'],
    category_id: row.category,
    category: row['category.name'],
    is_transfer: row.transfer_id !== null,
    is_split: Boolean(row.is_parent || row.is_child),
    reconciled: Boolean(row.reconciled),
  };
}

/**
 * Every transaction that could still become one side of a transfer: not a
 * transfer already, not part of a split, and not for nothing. All accounts are
 * read, tracking accounts too, because savings and investments are exactly
 * where a transfer's other side tends to live.
 */
export async function loadUnlinkedPool(
  ctx: ActualContext,
  { startDate, endDate }: { startDate?: string; endDate?: string } = {},
): Promise<TransferCandidate[]> {
  const rows = await queryRows(
    ctx,
    ctx.api
      .q('transactions')
      .filter({
        $and: [
          { transfer_id: null },
          { is_parent: false },
          { is_child: false },
          { amount: { $ne: 0 } },
          startDate && { date: { $gte: startDate } },
          endDate && { date: { $lte: endDate } },
        ],
      })
      .select(FIELDS)
      .orderBy(['date', 'id'])
      .options({ splits: 'all' }),
    rowSchema,
  );
  return rows.map(toSide);
}

/** The transactions with these ids. Unknown ids are left out. */
export async function loadTransferSides(
  ctx: ActualContext,
  ids: string[],
): Promise<Map<string, TransferSide>> {
  // ActualQL inlines the values of an id comparison, so only text that cannot
  // hold a quote may be offered to it. A real id never has one.
  const safe = ids.filter(id => ID_SHAPED.test(id));
  if (safe.length === 0) return new Map();
  const rows = await queryRows(
    ctx,
    ctx.api
      .q('transactions')
      .filter({ id: { $oneof: safe } })
      .select(FIELDS)
      .options({ splits: 'all' }),
    rowSchema,
  );
  return new Map(rows.map(row => [row.id, toSide(row)]));
}

/** Each account's transfer payee: the payee that marks a transfer to it. */
export async function transferPayees(
  ctx: ActualContext,
): Promise<Map<string, string>> {
  const payees = await ctx.api.getPayees();
  return new Map(
    payees.flatMap(payee =>
      payee.transfer_acct ? [[payee.transfer_acct, payee.id] as const] : [],
    ),
  );
}

export type AccountInfo = { id: string; name: string; off_budget: boolean };

/** An account from its id or exact name (case-insensitive). */
export async function resolveAccount(
  ctx: ActualContext,
  text: string,
): Promise<AccountInfo> {
  const accounts = await ctx.api.getAccounts();
  const wanted = text.trim().toLowerCase();
  const matches = accounts.filter(
    account =>
      account.id === text.trim() || account.name.toLowerCase() === wanted,
  );
  if (matches.length === 1) {
    const [account] = matches;
    return {
      id: account.id,
      name: account.name,
      off_budget: Boolean(account.offbudget),
    };
  }
  const known = accounts
    .filter(account => !account.closed)
    .map(account => account.name)
    .join(', ');
  throw toolError(
    matches.length > 1
      ? `account name "${text}" is ambiguous. Use its id.`
      : `unknown account "${text}". Known accounts: ${known || 'none'}.`,
  );
}

// loot-core types a transaction's category as `string | undefined`, but its
// batch update takes null to clear one, as Actual's own "make transfer" does.
const NO_CATEGORY = z.custom<string | undefined>().parse(null);

/** Two existing transactions to make into one transfer. */
export type LinkOp = {
  first: TransferSide;
  second: TransferSide;
  /** Each side's new payee: the transfer payee of the other side's account. */
  firstPayee: string;
  secondPayee: string;
  /** Actual drops the category of a transfer between two accounts of one kind. */
  clearCategory: boolean;
};

/**
 * Whether Actual keeps a transfer's category: it only drops it when both
 * accounts are on budget or both are off budget.
 */
export function transferDropsCategory(
  a: { account_off_budget: boolean },
  b: { account_off_budget: boolean },
): boolean {
  return a.account_off_budget === b.account_off_budget;
}

/**
 * Links transactions that already exist on both sides. loot-core has no
 * operation for this: giving a transaction a transfer payee always creates a
 * second, matching transaction. Writing the payees and `transfer_id` by hand,
 * with the transfer logic switched off, is what links two that are there.
 */
export async function applyLinks(
  ctx: ActualContext,
  ops: LinkOp[],
): Promise<void> {
  if (ops.length === 0) return;

  const cleared = (op: LinkOp) =>
    op.clearCategory ? { category: NO_CATEGORY } : {};
  await ctx.lootCore.send('transactions-batch-update', {
    updated: ops.flatMap(op => [
      {
        id: op.first.id,
        payee: op.firstPayee,
        transfer_id: op.second.id,
        ...cleared(op),
      },
      {
        id: op.second.id,
        payee: op.secondPayee,
        transfer_id: op.first.id,
        ...cleared(op),
      },
    ]),
    runTransfers: false,
  });

  const rows = await rawTransferIds(
    ctx,
    ops.flatMap(op => [op.first.id, op.second.id]),
  );
  const missed = ops.filter(
    op =>
      rows.get(op.first.id) !== op.second.id ||
      rows.get(op.second.id) !== op.first.id,
  );
  if (missed.length > 0) {
    throw new Error(
      `${missed.length} of ${ops.length} transfers did not link (for example ${missed[0].first.id} and ${missed[0].second.id}). Check them with get_transactions before trying again.`,
    );
  }
}

/** A transaction to turn into a transfer by creating its other side. */
export type CreateOp = {
  side: TransferSide;
  /** The transfer payee of the account the other side goes in. */
  payee: string;
};

/**
 * Makes each transaction a transfer by giving it the other account's transfer
 * payee, which is how Actual's own screens do it: loot-core then creates the
 * matching transaction in that account (same date and notes, opposite amount).
 */
export async function applyCreations(
  ctx: ActualContext,
  ops: CreateOp[],
): Promise<void> {
  if (ops.length === 0) return;

  await ctx.lootCore.send('transactions-batch-update', {
    updated: ops.map(op => ({ id: op.side.id, payee: op.payee })),
  });

  const rows = await rawTransferIds(
    ctx,
    ops.map(op => op.side.id),
  );
  const missed = ops.filter(op => !rows.get(op.side.id));
  if (missed.length > 0) {
    throw new Error(
      `${missed.length} of ${ops.length} transfers were not created (for example ${missed[0].side.id}). Check them with get_transactions before trying again.`,
    );
  }
}

const transferIdRow = z.object({
  id: z.string(),
  transfer_id: z.string().nullable(),
});

async function rawTransferIds(
  ctx: ActualContext,
  ids: string[],
): Promise<Map<string, string | null>> {
  const rows = await queryRows(
    ctx,
    ctx.api
      .q('transactions')
      .filter({ id: { $oneof: ids.filter(id => ID_SHAPED.test(id)) } })
      .select(['id', 'transfer_id'])
      .options({ splits: 'all' }),
    transferIdRow,
  );
  return new Map(rows.map(row => [row.id, row.transfer_id]));
}
