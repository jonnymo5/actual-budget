import type { AmountConverter } from '#actual/amounts';

import { addMonths, daysBetween, firstDayOf, monthOf } from './dates';
import type { Period } from './dates';
import { mean, median, quantileSorted, stdev } from './statistics';
import { briefOf, classifyFlow } from './transactions';
import type { AnalysisTransaction, TransactionBrief } from './transactions';

export type Sensitivity = 'low' | 'medium' | 'high';

/** How far above the upper quartile, in interquartile ranges, an amount must be. */
export const IQR_MULTIPLIER: Record<Sensitivity, number> = {
  low: 3,
  medium: 2,
  high: 1.5,
};

/** Past purchases a payee needs before its own history is the yardstick. */
export const MIN_PAYEE_SAMPLES = 5;
/** Past purchases a category needs before it is the yardstick instead. */
export const MIN_CATEGORY_SAMPLES = 8;
/** An amount is only unusual if it is at least this many times the typical one. */
export const MIN_TIMES_TYPICAL = 1.5;
/** Past purchases needed before "large first purchase from a new payee" means anything. */
export const MIN_HISTORY_FOR_NEW_PAYEES = 20;
/** Days of history the budget needs before a payee can be called new. */
export const MIN_DAYS_FOR_NEW_PAYEES = 30;

export type OutlierType = 'unusual_amount' | 'new_payee' | 'possible_duplicate';

export type Outlier = {
  type: OutlierType;
  transaction: TransactionBrief;
  reason: string;
  /** For a possible duplicate: the earlier transaction it repeats. */
  related_transaction: TransactionBrief | null;
  days_apart: number | null;
  /** For an unusual amount: where the yardstick came from. */
  baseline: 'payee' | 'category' | null;
  baseline_size: number | null;
  /** The median past amount, major units, signed like amounts. */
  typical_amount: number | null;
  times_typical: number | null;
  /** Standard deviations above the past mean; null when the past never varied. */
  z_score: number | null;
};

export type OutlierReport = {
  /** Every finding, largest amount first. */
  outliers: Outlier[];
  /** Why a check did not run, e.g. too little history. */
  notes: string[];
  history_start: string;
  /** Spending transactions in the window that were checked. */
  checked_count: number;
};

type OutlierOptions = {
  /** Everything up to the end of the window, in any order. */
  transactions: AnalysisTransaction[];
  window: Period;
  /** How many months before the window the yardstick looks back. */
  historyMonths: number;
  sensitivity: Sensitivity;
  /** Minor units: smaller amounts are never reported. */
  minAmount: number;
  duplicateWindowDays: number;
  /** The date of the budget's first transaction. */
  dataStartDate: string | null;
  money: AmountConverter;
};

const byDateThenId = (a: AnalysisTransaction, b: AnalysisTransaction) =>
  a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

function group<Key>(
  transactions: AnalysisTransaction[],
  keyOf: (transaction: AnalysisTransaction) => Key | null,
): Map<Key, AnalysisTransaction[]> {
  const groups = new Map<Key, AnalysisTransaction[]>();
  for (const transaction of transactions) {
    const key = keyOf(transaction);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), transaction]);
  }
  return groups;
}

export function findOutliers({
  transactions,
  window,
  historyMonths,
  sensitivity,
  minAmount,
  duplicateWindowDays,
  dataStartDate,
  money,
}: OutlierOptions): OutlierReport {
  const all = [...transactions].sort(byDateThenId);
  const historyStart = firstDayOf(
    addMonths(monthOf(window.start), -historyMonths),
  );
  const inWindow = (transaction: AnalysisTransaction) =>
    transaction.date >= window.start && transaction.date <= window.end;
  const notes: string[] = [];
  const outliers: Outlier[] = [];
  const show = (minor: number) => money.format(money.toMajor(Math.abs(minor)));
  const brief = (transaction: AnalysisTransaction) =>
    briefOf(transaction, money.toMajor);
  const label = (transaction: AnalysisTransaction) =>
    transaction.payee ?? transaction.category ?? 'a purchase';

  // Purchases only: refunds and income are never "unusually large charges".
  const purchases = all.filter(
    transaction =>
      classifyFlow(transaction) === 'spending' &&
      transaction.amount < 0 &&
      transaction.date >= historyStart,
  );
  const checked = purchases.filter(inWindow);
  const byPayee = group(purchases, t => t.payee_id);
  const byCategory = group(purchases, t => t.category_id);

  // Unusual amounts: compared with what the same payee (or, failing that, the
  // same category) usually costs, using quartiles so one past blow-out does
  // not hide the next.
  for (const transaction of checked) {
    const peers = (list: AnalysisTransaction[] | undefined) =>
      (list ?? []).filter(other => other.id !== transaction.id);
    const payeePeers = peers(
      transaction.payee_id ? byPayee.get(transaction.payee_id) : undefined,
    );
    const categoryPeers = peers(
      transaction.category_id
        ? byCategory.get(transaction.category_id)
        : undefined,
    );
    const baseline =
      payeePeers.length >= MIN_PAYEE_SAMPLES
        ? { kind: 'payee' as const, peers: payeePeers }
        : categoryPeers.length >= MIN_CATEGORY_SAMPLES
          ? { kind: 'category' as const, peers: categoryPeers }
          : null;
    if (!baseline) continue;

    const sizes = baseline.peers
      .map(peer => -peer.amount)
      .sort((a, b) => a - b);
    const upperQuartile = quantileSorted(sizes, 0.75);
    const spread = upperQuartile - quantileSorted(sizes, 0.25);
    const fence = upperQuartile + IQR_MULTIPLIER[sensitivity] * spread;
    const typical = median(sizes);
    const size = -transaction.amount;
    const timesTypical = size / typical;
    if (size <= fence || timesTypical < MIN_TIMES_TYPICAL || size < minAmount) {
      continue;
    }

    const deviation = stdev(sizes);
    outliers.push({
      type: 'unusual_amount',
      transaction: brief(transaction),
      reason: `${label(transaction)} ${show(size)} is ${timesTypical.toFixed(1)}x the usual ${show(typical)} for this ${baseline.kind} (${baseline.peers.length} earlier purchases)`,
      related_transaction: null,
      days_apart: null,
      baseline: baseline.kind,
      baseline_size: baseline.peers.length,
      typical_amount: money.toMajor(-Math.round(typical)),
      times_typical: Math.round(timesTypical * 10) / 10,
      z_score:
        deviation === 0
          ? null
          : Math.round(((size - mean(sizes)) / deviation) * 10) / 10,
    });
  }

  // New payees: a first-ever purchase that is large for this budget.
  const hasHistory =
    dataStartDate !== null &&
    daysBetween(dataStartDate, window.start) >= MIN_DAYS_FOR_NEW_PAYEES;
  const pastSizes = purchases
    .filter(transaction => transaction.date < window.start)
    .map(transaction => -transaction.amount)
    .sort((a, b) => a - b);
  if (!hasHistory || pastSizes.length < MIN_HISTORY_FOR_NEW_PAYEES) {
    notes.push(
      `Skipped the new-payee check: it needs at least ${MIN_DAYS_FOR_NEW_PAYEES} days and ${MIN_HISTORY_FOR_NEW_PAYEES} purchases of history before ${window.start}.`,
    );
  } else {
    const largeSize = Math.max(quantileSorted(pastSizes, 0.9), minAmount);
    const firstSeen = new Map<string, AnalysisTransaction>();
    for (const transaction of all) {
      if (transaction.payee_id && !firstSeen.has(transaction.payee_id)) {
        firstSeen.set(transaction.payee_id, transaction);
      }
    }
    for (const transaction of checked) {
      const first = transaction.payee_id
        ? firstSeen.get(transaction.payee_id)
        : undefined;
      if (first?.id !== transaction.id || -transaction.amount < largeSize) {
        continue;
      }
      outliers.push({
        type: 'new_payee',
        transaction: brief(transaction),
        reason: `first purchase ever from ${label(transaction)}, and at ${show(transaction.amount)} it is as large as the biggest 10% of past purchases (${show(largeSize)} or more)`,
        related_transaction: null,
        days_apart: null,
        baseline: null,
        baseline_size: null,
        typical_amount: null,
        times_typical: null,
        z_score: null,
      });
    }
  }

  // Possible duplicates: the same payee charging the same amount to the same
  // account again within a few days. Income counts too (a double deposit).
  const flows = all.filter(
    transaction =>
      classifyFlow(transaction) !== null &&
      transaction.payee_id !== null &&
      Math.abs(transaction.amount) >= minAmount &&
      transaction.date >= historyStart,
  );
  const repeats = group(
    flows,
    t => `${t.account_id}|${t.payee_id}|${t.amount}`,
  );
  for (const list of repeats.values()) {
    for (let index = 1; index < list.length; index++) {
      const earlier = list[index - 1];
      const later = list[index];
      const gap = daysBetween(earlier.date, later.date);
      if (gap > duplicateWindowDays || !inWindow(later)) continue;
      outliers.push({
        type: 'possible_duplicate',
        transaction: brief(later),
        reason: `${label(later)} ${show(later.amount)} appears again ${gap === 0 ? 'on the same day' : `${gap} day${gap === 1 ? '' : 's'} after ${earlier.date}`} in the same account`,
        related_transaction: brief(earlier),
        days_apart: gap,
        baseline: null,
        baseline_size: null,
        typical_amount: null,
        times_typical: null,
        z_score: null,
      });
    }
  }

  // A first purchase from a new payee is also compared with its category. Say
  // it once, as the more specific finding.
  const newPayeeIds = new Set(
    outliers
      .filter(outlier => outlier.type === 'new_payee')
      .map(outlier => outlier.transaction.id),
  );
  const findings = outliers.filter(
    outlier =>
      !(
        outlier.type === 'unusual_amount' &&
        newPayeeIds.has(outlier.transaction.id)
      ),
  );

  findings.sort(
    (a, b) =>
      Math.abs(b.transaction.amount) - Math.abs(a.transaction.amount) ||
      a.transaction.id.localeCompare(b.transaction.id),
  );
  return {
    outliers: findings,
    notes,
    history_start: historyStart,
    checked_count: checked.length,
  };
}
