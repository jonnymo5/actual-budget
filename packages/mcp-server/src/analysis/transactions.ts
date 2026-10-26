/** What the analysis needs to know about a transaction. */
export type AnalysisTransaction = {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Integer minor units (cents), spending negative. */
  amount: number;
  account_id: string;
  account: string | null;
  account_off_budget: boolean;
  payee_id: string | null;
  payee: string | null;
  category_id: string | null;
  category: string | null;
  category_group: string | null;
  /** True when the category is one of the budget's income categories. */
  category_is_income: boolean;
  is_transfer: boolean;
  /**
   * For a transfer: whether the account on its other side is a tracking
   * (off-budget) account, such as savings or investments. False otherwise.
   */
  transfer_counterpart_off_budget: boolean;
};

export type FlowKind = 'spending' | 'income';

export const UNCATEGORIZED = '(uncategorized)';
export const NO_PAYEE = '(no payee)';

/**
 * Money that came in from a tracking account (savings, an investment sale)
 * and so is not earnings, however it is categorised. Filing it under an income
 * category is how it reaches the envelopes to be spent, but it must not make a
 * month look richer than it was.
 */
export function isSavingsDraw(transaction: AnalysisTransaction): boolean {
  return (
    transaction.is_transfer &&
    transaction.amount > 0 &&
    !transaction.account_off_budget &&
    transaction.transfer_counterpart_off_budget
  );
}

/**
 * Whether a transaction is money spent, money earned, or neither.
 *
 * A category decides when there is one, so a refund in a spending category
 * reduces spending instead of counting as income. Without a category the sign
 * decides. Transfers between accounts are neither, unless they carry a
 * category (a transfer to an off-budget account that was budgeted as an
 * expense). Money drawn from a tracking account is never income or spending.
 */
export function classifyFlow(
  transaction: AnalysisTransaction,
): FlowKind | null {
  if (transaction.amount === 0) return null;
  if (isSavingsDraw(transaction)) return null;
  if (transaction.category_id !== null) {
    return transaction.category_is_income ? 'income' : 'spending';
  }
  if (transaction.is_transfer) return null;
  return transaction.amount < 0 ? 'spending' : 'income';
}

export function filterFlow(
  transactions: AnalysisTransaction[],
  kind: FlowKind,
): AnalysisTransaction[] {
  return transactions.filter(transaction => classifyFlow(transaction) === kind);
}

export type GroupBy = 'category' | 'category_group' | 'payee' | 'month';

/** The bucket a transaction falls into when grouping. `key` is stable, `name` is for people. */
export function groupOf(
  transaction: AnalysisTransaction,
  groupBy: GroupBy,
): { key: string; name: string } {
  switch (groupBy) {
    case 'category':
      return transaction.category_id === null
        ? { key: 'uncategorized', name: UNCATEGORIZED }
        : {
            key: transaction.category_id,
            name: transaction.category ?? transaction.category_id,
          };
    case 'category_group': {
      const name = transaction.category_group ?? UNCATEGORIZED;
      return { key: name, name };
    }
    case 'payee':
      return transaction.payee_id === null
        ? { key: 'no-payee', name: NO_PAYEE }
        : {
            key: transaction.payee_id,
            name: transaction.payee ?? transaction.payee_id,
          };
    default: {
      // 'month'
      const month = transaction.date.slice(0, 7);
      return { key: month, name: month };
    }
  }
}

/** A transaction as shown in analysis results. */
export type TransactionBrief = {
  id: string;
  date: string;
  /** Major units, signed: spending is negative. */
  amount: number;
  account: string | null;
  payee: string | null;
  category: string | null;
};

export function briefOf(
  transaction: AnalysisTransaction,
  toMajor: (minor: number) => number,
): TransactionBrief {
  return {
    id: transaction.id,
    date: transaction.date,
    amount: toMajor(transaction.amount),
    account: transaction.account,
    payee: transaction.payee,
    category: transaction.category,
  };
}
