import { z } from 'zod';

import type { AnalysisTransaction } from '#analysis/transactions';

import { queryRows } from './query';
import type { ActualContext } from './session';

// The fields the analysis reads, as ActualQL returns them: joined fields come
// back under their dotted name.
const SELECTED_FIELDS = [
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
  'category.is_income',
  'category.group.name',
  'category.group.is_income',
  'transfer_id',
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
  'category.is_income': z.boolean().nullable(),
  'category.group.name': z.string().nullable(),
  'category.group.is_income': z.boolean().nullable(),
  transfer_id: z.string().nullable(),
});

export type AnalysisFilters = {
  /** Inclusive; omit to start at the beginning of the budget. */
  startDate?: string;
  endDate: string;
  accountId?: string;
  /** Tracking accounts are left out unless asked for. */
  includeOffBudget: boolean;
};

/**
 * Every transaction in the range, oldest first, with only the fields the
 * analysis needs. Split transactions are read inline, so each split line is a
 * row and the parent is left out. The rows stay on the server: the analysis
 * boils them down before anything is returned to the model.
 */
export async function loadAnalysisTransactions(
  ctx: ActualContext,
  filters: AnalysisFilters,
): Promise<AnalysisTransaction[]> {
  const conditions = [
    filters.startDate && { date: { $gte: filters.startDate } },
    { date: { $lte: filters.endDate } },
    filters.accountId && { account: filters.accountId },
    !filters.includeOffBudget && { 'account.offbudget': false },
  ];
  const rows = await queryRows(
    ctx,
    ctx.api
      .q('transactions')
      .filter({ $and: conditions })
      .select(SELECTED_FIELDS)
      .orderBy(['date', 'id']),
    rowSchema,
  );

  return rows.map(row => ({
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
    category_group: row['category.group.name'],
    // Actual keeps the income flag on the category and on its group, and
    // categories made through the API or an import may only have the group's.
    category_is_income: Boolean(
      row['category.is_income'] || row['category.group.is_income'],
    ),
    is_transfer: row.transfer_id !== null,
  }));
}

const firstDateSchema = z.object({ date: z.string() });

/** The date of the budget's oldest transaction, or null for an empty budget. */
export async function getFirstTransactionDate(
  ctx: ActualContext,
): Promise<string | null> {
  const [first] = await queryRows(
    ctx,
    ctx.api.q('transactions').select('date').orderBy('date').limit(1),
    firstDateSchema,
  );
  return first?.date ?? null;
}
