import { z } from 'zod';

import { toolError } from '#errors';

import { queryRows } from './query';
import type { ActualContext } from './session';
import { assertKnownAccount } from './transactions';

export type UncategorizedFilters = {
  startDate?: string;
  endDate?: string;
  accountId?: string;
  /** Payee groups per page. */
  limit: number;
  offset: number;
  /** Newest transactions to list for each group. */
  samplesPerGroup: number;
};

export type UncategorizedSample = {
  id: string;
  date: string;
  /** Major units, signed. */
  amount: number;
  account: string | null;
  notes: string | null;
  /** The description the bank sent, before any renaming. */
  imported_payee: string | null;
};

export type UncategorizedGroup = {
  /** Null for transactions that have no payee at all. */
  payee_id: string | null;
  payee: string | null;
  count: number;
  /** Major units, signed. */
  total_amount: number;
  first_date: string;
  last_date: string;
  /** What this payee's categorised transactions use, most common first. */
  usual_categories: { category_id: string; category: string; count: number }[];
  transactions: UncategorizedSample[];
};

export type UncategorizedPage = {
  total_count: number;
  total_amount: number;
  group_count: number;
  groups: UncategorizedGroup[];
  offset: number;
  has_more: boolean;
};

const rowSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  'account.name': z.string().nullable(),
  payee: z.string().nullable(),
  'payee.name': z.string().nullable(),
  notes: z.string().nullable(),
  imported_payee: z.string().nullable(),
});

const historySchema = z.object({
  payee: z.string(),
  category: z.string(),
  'category.name': z.string().nullable(),
  count: z.number(),
});

const USUAL_CATEGORIES = 3;

/**
 * The transactions that still need a category, grouped by payee so that one
 * decision can cover many of them. Transfers, tracking (off-budget) accounts
 * and the summary line of a split are not counted: Actual does not categorise
 * those either.
 */
export async function listUncategorized(
  ctx: ActualContext,
  filters: UncategorizedFilters,
): Promise<UncategorizedPage> {
  if (filters.accountId) await assertKnownAccount(ctx, filters.accountId);
  if (
    filters.startDate &&
    filters.endDate &&
    filters.startDate > filters.endDate
  ) {
    throw toolError(
      `start_date (${filters.startDate}) must not be after end_date (${filters.endDate}).`,
    );
  }

  const rows = await queryRows(
    ctx,
    ctx.api
      .q('transactions')
      .filter({
        $and: [
          { category: null },
          { transfer_id: null },
          { 'account.offbudget': false },
          filters.startDate && { date: { $gte: filters.startDate } },
          filters.endDate && { date: { $lte: filters.endDate } },
          filters.accountId && { account: filters.accountId },
        ],
      })
      .select([
        'id',
        'date',
        'amount',
        'account.name',
        'payee',
        'payee.name',
        'notes',
        'imported_payee',
      ])
      .orderBy([{ date: 'desc' }, 'id']),
    rowSchema,
  );

  // Sums are kept in minor units until the end, so cents never drift.
  const byPayee = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const group = byPayee.get(row.payee);
    if (group) group.push(row);
    else byPayee.set(row.payee, [row]);
  }
  const sumOf = (list: typeof rows) =>
    list.reduce((sum, row) => sum + row.amount, 0);

  const ordered = [...byPayee.entries()]
    .map(([payeeId, list]) => ({
      payeeId,
      list,
      total: sumOf(list),
    }))
    .sort(
      (a, b) =>
        b.list.length - a.list.length ||
        Math.abs(b.total) - Math.abs(a.total) ||
        (a.list[0]['payee.name'] ?? '').localeCompare(
          b.list[0]['payee.name'] ?? '',
        ),
    );
  const page = ordered.slice(filters.offset, filters.offset + filters.limit);

  const history = new Map<string, z.output<typeof historySchema>[]>();
  const payeeIds = page.flatMap(group =>
    group.payeeId ? [group.payeeId] : [],
  );
  if (payeeIds.length > 0) {
    // The ids come from the budget itself, never from the caller.
    const counts = await queryRows(
      ctx,
      ctx.api
        .q('transactions')
        .filter({ payee: { $oneof: payeeIds }, category: { $ne: null } })
        .groupBy(['payee', 'category', 'category.name'])
        .select([
          'payee',
          'category',
          'category.name',
          { count: { $count: '$id' } },
        ]),
      historySchema,
    );
    for (const entry of counts) {
      const list = history.get(entry.payee);
      if (list) list.push(entry);
      else history.set(entry.payee, [entry]);
    }
  }

  const { toMajor } = ctx.amounts;
  return {
    total_count: rows.length,
    total_amount: toMajor(sumOf(rows)),
    group_count: ordered.length,
    groups: page.map(({ payeeId, list, total }) => ({
      payee_id: payeeId,
      payee: list[0]['payee.name'],
      count: list.length,
      total_amount: toMajor(total),
      // The rows are newest first.
      first_date: list[list.length - 1].date,
      last_date: list[0].date,
      usual_categories: (payeeId ? (history.get(payeeId) ?? []) : [])
        .sort((a, b) => b.count - a.count)
        .slice(0, USUAL_CATEGORIES)
        .map(entry => ({
          category_id: entry.category,
          category: entry['category.name'] ?? entry.category,
          count: entry.count,
        })),
      transactions: list.slice(0, filters.samplesPerGroup).map(row => ({
        id: row.id,
        date: row.date,
        amount: toMajor(row.amount),
        account: row['account.name'],
        notes: row.notes,
        imported_payee: row.imported_payee,
      })),
    })),
    offset: filters.offset,
    has_more: filters.offset + page.length < ordered.length,
  };
}
