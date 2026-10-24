import type { AmountConverter } from '#actual/amounts';

import { monthRange } from './dates';
import { roundTo } from './statistics';
import { classifyFlow, groupOf } from './transactions';
import type { AnalysisTransaction, FlowKind, GroupBy } from './transactions';

export type SummaryKind = FlowKind | 'all';

/** How a period compares with the one before it. */
export type Comparison = {
  /** The previous period's total, major units. */
  previous_total: number;
  /** This period minus the previous one, major units (signed like amounts). */
  change: number;
  /**
   * The change in size relative to the previous total, in percent: positive
   * means more spent (spending), more earned (income) or a larger net (all).
   * Null when the previous total was zero.
   */
  percent_change: number | null;
  direction: 'higher' | 'lower' | 'unchanged';
};

export type SummaryRow = {
  key: string;
  name: string;
  /** Major units, signed: spending is negative. */
  total: number;
  transaction_count: number;
  /** This row's part of the overall total, 0 to 1. Null for `all` or a zero total. */
  share: number | null;
  /** Null unless a previous period was given. */
  comparison: Comparison | null;
};

export type SpendingSummary = {
  total: number;
  transaction_count: number;
  comparison: Comparison | null;
  rows: SummaryRow[];
  /** The rows beyond the limit, added together. */
  other: SummaryRow | null;
};

type Bucket = { key: string; name: string; total: number; count: number };

function bucketize(
  transactions: AnalysisTransaction[],
  kind: SummaryKind,
  groupBy: GroupBy,
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const transaction of transactions) {
    const flow = classifyFlow(transaction);
    if (flow === null || (kind !== 'all' && flow !== kind)) continue;

    const { key, name } = groupOf(transaction, groupBy);
    const bucket = buckets.get(key) ?? { key, name, total: 0, count: 0 };
    bucket.total += transaction.amount;
    bucket.count++;
    buckets.set(key, bucket);
  }
  return buckets;
}

/** Positive when the amount grew in the sense the kind cares about. */
function directional(kind: SummaryKind, change: number): number {
  return kind === 'spending' ? -change : change;
}

export function compareTotals(
  kind: SummaryKind,
  current: number,
  previous: number,
  money: AmountConverter,
): Comparison {
  const change = current - previous;
  const grown = directional(kind, change);
  return {
    previous_total: money.toMajor(previous),
    change: money.toMajor(change),
    percent_change:
      previous === 0 ? null : roundTo(grown / Math.abs(previous), 1, 100),
    direction: grown > 0 ? 'higher' : grown < 0 ? 'lower' : 'unchanged',
  };
}

type SummarizeOptions = {
  transactions: AnalysisTransaction[];
  /** The previous period's transactions, when comparing. */
  previous?: AnalysisTransaction[];
  kind: SummaryKind;
  groupBy: GroupBy;
  /** Rows to keep before rolling the rest into `other`. Months are never cut. */
  limit: number;
  /** The first and last day of the period, to list empty months too. */
  period: { start: string; end: string };
  money: AmountConverter;
};

export function summarizeSpending({
  transactions,
  previous,
  kind,
  groupBy,
  limit,
  period,
  money,
}: SummarizeOptions): SpendingSummary {
  const current = bucketize(transactions, kind, groupBy);
  const before = previous ? bucketize(previous, kind, groupBy) : null;

  // A group that only exists in the previous period still belongs in the
  // comparison: it is spending that stopped.
  const keys = new Set([...current.keys(), ...(before?.keys() ?? [])]);
  if (groupBy === 'month') {
    for (const month of monthRange(
      period.start.slice(0, 7),
      period.end.slice(0, 7),
    )) {
      keys.add(month);
    }
  }

  const total = [...current.values()].reduce((sum, b) => sum + b.total, 0);
  const count = [...current.values()].reduce((sum, b) => sum + b.count, 0);
  const previousTotal = before
    ? [...before.values()].reduce((sum, b) => sum + b.total, 0)
    : null;

  function toRow(key: string): SummaryRow {
    const bucket = current.get(key);
    const earlier = before?.get(key);
    const amount = bucket?.total ?? 0;
    return {
      key,
      name: bucket?.name ?? earlier?.name ?? key,
      total: money.toMajor(amount),
      transaction_count: bucket?.count ?? 0,
      share: kind === 'all' || total === 0 ? null : roundTo(amount / total, 3),
      comparison: before
        ? compareTotals(kind, amount, earlier?.total ?? 0, money)
        : null,
    };
  }

  const size = (key: string) => Math.abs(current.get(key)?.total ?? 0);
  const earlierSize = (key: string) => Math.abs(before?.get(key)?.total ?? 0);
  const ordered = [...keys].sort((a, b) =>
    groupBy === 'month'
      ? a.localeCompare(b)
      : size(b) - size(a) ||
        earlierSize(b) - earlierSize(a) ||
        a.localeCompare(b),
  );

  const kept = groupBy === 'month' ? ordered : ordered.slice(0, limit);
  const rest = groupBy === 'month' ? [] : ordered.slice(limit);

  let other: SummaryRow | null = null;
  if (rest.length > 0) {
    const restTotal = rest.reduce(
      (sum, key) => sum + (current.get(key)?.total ?? 0),
      0,
    );
    const restBefore = rest.reduce(
      (sum, key) => sum + (before?.get(key)?.total ?? 0),
      0,
    );
    other = {
      key: 'other',
      name: `Other (${rest.length} more)`,
      total: money.toMajor(restTotal),
      transaction_count: rest.reduce(
        (sum, key) => sum + (current.get(key)?.count ?? 0),
        0,
      ),
      share:
        kind === 'all' || total === 0 ? null : roundTo(restTotal / total, 3),
      comparison: before
        ? compareTotals(kind, restTotal, restBefore, money)
        : null,
    };
  }

  return {
    total: money.toMajor(total),
    transaction_count: count,
    comparison:
      previousTotal === null
        ? null
        : compareTotals(kind, total, previousTotal, money),
    rows: kept.map(toRow),
    other,
  };
}
