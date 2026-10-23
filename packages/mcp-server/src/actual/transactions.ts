import { z } from 'zod';

import { toolError } from '#errors';

import { queryRows } from './query';
import type { AqlQuery } from './query';
import type { ActualContext } from './session';

export type TransactionFilters = {
  accountId?: string;
  startDate: string;
  endDate: string;
  category?: string;
  payee?: string;
  /** Major units, signed: spending is negative. */
  minAmount?: number;
  maxAmount?: number;
  searchText?: string;
  limit: number;
  offset: number;
};

export const transactionRowSchema = z.object({
  id: z.string(),
  date: z.string(),
  account_id: z.string(),
  account: z.string().nullable(),
  payee_id: z.string().nullable(),
  payee: z.string().nullable(),
  category_id: z.string().nullable(),
  category: z.string().nullable(),
  amount: z.number(),
  notes: z.string().nullable(),
  cleared: z.boolean(),
  is_transfer: z.boolean(),
});

export type TransactionRow = z.output<typeof transactionRowSchema>;

export type TransactionPage = {
  transactions: TransactionRow[];
  /** How many transactions match the filters across all pages. */
  total_count: number;
  /** Net sum, in major units, of every matching transaction (not just this page). */
  total_amount: number;
  offset: number;
  has_more: boolean;
};

// The raw shape ActualQL returns for the fields selected below; joined fields
// come back under their dotted name.
const rawRowSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  account: z.string(),
  'account.name': z.string().nullable(),
  payee: z.string().nullable(),
  'payee.name': z.string().nullable(),
  category: z.string().nullable(),
  'category.name': z.string().nullable(),
  notes: z.string().nullable(),
  cleared: z.boolean().nullable(),
  transfer_id: z.string().nullable(),
});

const totalsSchema = z.object({
  count: z.number(),
  total: z.number().nullable(),
});

const SELECTED_FIELDS = [
  'id',
  'date',
  'amount',
  'account',
  'account.name',
  'payee',
  'payee.name',
  'category',
  'category.name',
  'notes',
  'cleared',
  'transfer_id',
];

const MAX_SUGGESTIONS = 15;

export async function assertKnownAccount(
  ctx: ActualContext,
  accountId: string,
) {
  const accounts = await ctx.api.getAccounts();
  if (accounts.some(account => account.id === accountId)) return;

  const known = accounts
    .map(account => `${account.name} (${account.id})`)
    .join(', ');
  throw toolError(
    `unknown account_id "${accountId}". Known accounts: ${known || 'none'}.`,
  );
}

// Matching is on the budget's own category list rather than interpolated into
// the query, so only ids that really exist ever reach ActualQL.
export async function resolveCategoryIds(
  ctx: ActualContext,
  category: string,
): Promise<string[]> {
  const categories = await ctx.api.getCategories();
  const wanted = category.trim().toLowerCase();
  const matches = categories.filter(
    candidate =>
      candidate.id === category.trim() ||
      candidate.name.toLowerCase() === wanted,
  );
  if (matches.length > 0) return matches.map(match => match.id);

  const similar = categories.filter(candidate => {
    const name = candidate.name.toLowerCase();
    return name.includes(wanted) || wanted.includes(name);
  });
  const candidates = similar.length > 0 ? similar : categories;
  const names = candidates
    .slice(0, MAX_SUGGESTIONS)
    .map(candidate => candidate.name)
    .join(', ');
  const truncated =
    candidates.length > MAX_SUGGESTIONS
      ? ` (showing ${MAX_SUGGESTIONS} of ${candidates.length}; get_overview lists every category)`
      : '';
  throw toolError(
    `unknown category "${category}". ${similar.length > 0 ? 'Did you mean' : 'Available categories'}: ${names}${truncated}.`,
  );
}

// ActualQL escapes string values but inlines values compared with an id field
// as-is, so caller text must never reach an id comparison unless it cannot
// contain a quote. Real ids are uuid-like, so only id-shaped text is tried.
export const ID_SHAPED = /^[\w-]{1,64}$/;

// Matches when the text appears in any of `likeFields` (case-insensitive), or
// equals the value of any of `idFields`.
function textMatch(
  likeFields: string[],
  text: string,
  idFields: string[] = [],
) {
  const trimmed = text.trim();
  const matchesIds = ID_SHAPED.test(trimmed) ? idFields : [];
  return {
    $or: [
      ...likeFields.map(field => ({ [field]: { $like: `%${trimmed}%` } })),
      ...matchesIds.map(field => ({ [field]: trimmed })),
    ],
  };
}

export async function queryTransactions(
  ctx: ActualContext,
  filters: TransactionFilters,
): Promise<TransactionPage> {
  if (filters.startDate > filters.endDate) {
    throw toolError(
      `start_date (${filters.startDate}) must not be after end_date (${filters.endDate}).`,
    );
  }
  if (filters.accountId) await assertKnownAccount(ctx, filters.accountId);
  const categoryIds = filters.category
    ? await resolveCategoryIds(ctx, filters.category)
    : null;

  const conditions = [
    { date: { $gte: filters.startDate } },
    { date: { $lte: filters.endDate } },
    filters.accountId && { account: filters.accountId },
    categoryIds && { category: { $oneof: categoryIds } },
    filters.payee &&
      textMatch(['payee.name', 'imported_payee'], filters.payee, ['payee']),
    filters.minAmount !== undefined && {
      amount: { $gte: ctx.amounts.toMinor(filters.minAmount) },
    },
    filters.maxAmount !== undefined && {
      amount: { $lte: ctx.amounts.toMinor(filters.maxAmount) },
    },
    filters.searchText &&
      textMatch(['notes', 'payee.name', 'imported_payee'], filters.searchText),
  ];
  // Splits are read inline: each split line is a row and the parent is left
  // out, so amounts are never counted twice.
  return readTransactionPage(
    ctx,
    ctx.api.q('transactions').filter({ $and: conditions }),
    { limit: filters.limit, offset: filters.offset },
  );
}

/**
 * One page of the transactions a filtered query matches, newest first, with
 * the count and net sum over every match.
 */
export async function readTransactionPage(
  ctx: ActualContext,
  matching: AqlQuery,
  { limit, offset }: { limit: number; offset: number },
): Promise<TransactionPage> {
  const rows = await queryRows(
    ctx,
    matching
      .select(SELECTED_FIELDS)
      .orderBy([{ date: 'desc' }, 'id'])
      .limit(limit)
      .offset(offset),
    rawRowSchema,
  );
  const [totals] = await queryRows(
    ctx,
    matching.select([
      { count: { $count: '$id' } },
      { total: { $sum: '$amount' } },
    ]),
    totalsSchema,
  );
  const { count, total } = totals ?? { count: 0, total: 0 };

  return {
    transactions: rows.map(row => ({
      id: row.id,
      date: row.date,
      account_id: row.account,
      account: row['account.name'],
      payee_id: row.payee,
      payee: row['payee.name'],
      category_id: row.category,
      category: row['category.name'],
      amount: ctx.amounts.toMajor(row.amount),
      notes: row.notes,
      cleared: row.cleared ?? false,
      is_transfer: row.transfer_id !== null,
    })),
    total_count: count,
    total_amount: ctx.amounts.toMajor(total ?? 0),
    offset,
    has_more: offset + rows.length < count,
  };
}
