import { daysBetween } from './dates';

/** A transaction that could be one side of a transfer between two accounts. */
export type TransferCandidate = {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Integer minor units, signed: money out is negative. */
  amount: number;
  account_id: string;
  account: string | null;
  account_off_budget: boolean;
  payee: string | null;
  category_id: string | null;
  category: string | null;
};

/**
 * Why a pair is not certain enough to link without asking.
 *
 * - `several_possible_matches`: another transaction fits either side just as
 *   well, so the pairing could be wrong (two equal card payments in a week).
 * - `dates_far_apart`: the two sides are more than `CLEAR_MAX_DAYS` apart.
 * - `category_would_be_cleared`: both accounts are on budget (or both off), so
 *   Actual drops the category of a transfer between them, and one side has one.
 * - `counterpart_already_exists`: asked to create the other side, but a
 *   transaction that would be it is already there.
 */
export type MatchReason =
  | 'several_possible_matches'
  | 'dates_far_apart'
  | 'category_would_be_cleared'
  | 'counterpart_already_exists';

export type TransferMatch = {
  status: 'clear' | 'needs_confirmation';
  /** The side where money left. */
  from: TransferCandidate;
  /**
   * The side where money arrived. When several fit, the nearest by date; null
   * when two are equally near and nothing says which is right.
   */
  to: TransferCandidate | null;
  /** Every transaction that could be `to`, listed when there is more than one. */
  alternatives: TransferCandidate[];
  /** Other outflows that fit `to` just as well as `from` does. */
  competing: TransferCandidate[];
  /** Calendar days between the two sides; null when `to` is null. */
  days_apart: number | null;
  reasons: MatchReason[];
};

/** Two sides further apart than this are never called clear. */
export const CLEAR_MAX_DAYS = 3;
export const DEFAULT_WINDOW_DAYS = 4;
export const MAX_WINDOW_DAYS = 14;

export const REASON_TEXT: Record<MatchReason, string> = {
  several_possible_matches:
    'more than one transaction fits, so the pairing could be wrong',
  dates_far_apart: `the two sides are more than ${CLEAR_MAX_DAYS} days apart`,
  category_would_be_cleared:
    'Actual drops the category of a transfer between two on-budget (or two off-budget) accounts, and one side has one',
  counterpart_already_exists:
    'a transaction that would be the other side already exists; link to it instead of creating a duplicate',
};

type Index = {
  /** Inflows in another account with the opposite amount, within the window. */
  inflowsFor: (outflow: TransferCandidate) => TransferCandidate[];
  /** Outflows in another account with the opposite amount, within the window. */
  outflowsFor: (inflow: TransferCandidate) => TransferCandidate[];
};

function indexPool(pool: TransferCandidate[], windowDays: number): Index {
  const inflows = new Map<number, TransferCandidate[]>();
  const outflows = new Map<number, TransferCandidate[]>();
  for (const transaction of pool) {
    if (transaction.amount === 0) continue;
    const bucket = transaction.amount > 0 ? inflows : outflows;
    const key = Math.abs(transaction.amount);
    bucket.set(key, [...(bucket.get(key) ?? []), transaction]);
  }

  const near = (a: TransferCandidate, b: TransferCandidate) =>
    a.account_id !== b.account_id &&
    Math.abs(daysBetween(a.date, b.date)) <= windowDays;

  return {
    inflowsFor: outflow =>
      (inflows.get(Math.abs(outflow.amount)) ?? []).filter(inflow =>
        near(outflow, inflow),
      ),
    outflowsFor: inflow =>
      (outflows.get(Math.abs(inflow.amount)) ?? []).filter(outflow =>
        near(outflow, inflow),
      ),
  };
}

function reasonsFor(
  index: Index,
  from: TransferCandidate,
  to: TransferCandidate,
): MatchReason[] {
  const reasons: MatchReason[] = [];
  const otherInflows = index
    .inflowsFor(from)
    .some(inflow => inflow.id !== to.id);
  const otherOutflows = index
    .outflowsFor(to)
    .some(outflow => outflow.id !== from.id);
  if (otherInflows || otherOutflows) reasons.push('several_possible_matches');

  if (Math.abs(daysBetween(from.date, to.date)) > CLEAR_MAX_DAYS) {
    reasons.push('dates_far_apart');
  }
  if (
    from.account_off_budget === to.account_off_budget &&
    (from.category_id !== null || to.category_id !== null)
  ) {
    reasons.push('category_would_be_cleared');
  }
  return reasons;
}

/**
 * Pairs up transactions that look like the two sides of one transfer: the same
 * amount with opposite signs, in different accounts, within `windowDays` of
 * each other. The pool is the transactions that are not transfers yet.
 *
 * A pair is `clear` when nothing else fits either side, the dates are close
 * and no category would be lost. Everything else needs a person's say-so.
 * Oldest first.
 */
export function findTransferMatches(
  pool: TransferCandidate[],
  { windowDays = DEFAULT_WINDOW_DAYS }: { windowDays?: number } = {},
): TransferMatch[] {
  const index = indexPool(pool, windowDays);
  const matches: TransferMatch[] = [];

  for (const from of pool) {
    if (from.amount >= 0) continue;
    const options = index.inflowsFor(from);
    if (options.length === 0) continue;

    const gap = (inflow: TransferCandidate) =>
      Math.abs(daysBetween(from.date, inflow.date));
    const nearest = [...options].sort((a, b) => gap(a) - gap(b));
    const tied = nearest.length > 1 && gap(nearest[0]) === gap(nearest[1]);
    const to = tied ? null : nearest[0];

    const reasons: MatchReason[] = to ? reasonsFor(index, from, to) : [];
    if (options.length > 1 && !reasons.includes('several_possible_matches')) {
      reasons.unshift('several_possible_matches');
    }
    matches.push({
      status: reasons.length === 0 ? 'clear' : 'needs_confirmation',
      from,
      to,
      alternatives: options.length > 1 ? nearest : [],
      competing: to
        ? index.outflowsFor(to).filter(outflow => outflow.id !== from.id)
        : [],
      days_apart: to ? gap(to) : null,
      reasons,
    });
  }

  return matches.sort(
    (a, b) =>
      a.from.date.localeCompare(b.from.date) ||
      a.from.id.localeCompare(b.from.id),
  );
}

/**
 * How sure a pair somebody picked is. Used before linking: the same rules as
 * `findTransferMatches`, applied to the one pair that was asked for.
 */
export function assessPair(
  pool: TransferCandidate[],
  from: TransferCandidate,
  to: TransferCandidate,
  { windowDays = DEFAULT_WINDOW_DAYS }: { windowDays?: number } = {},
): MatchReason[] {
  return reasonsFor(indexPool(pool, windowDays), from, to);
}

/**
 * Whether making `transaction` a transfer to `account` would duplicate a
 * transaction that is already there: one with the opposite amount, in that
 * account, within the window.
 */
export function findExistingCounterparts(
  pool: TransferCandidate[],
  transaction: TransferCandidate,
  accountId: string,
  { windowDays = DEFAULT_WINDOW_DAYS }: { windowDays?: number } = {},
): TransferCandidate[] {
  return pool.filter(
    other =>
      other.account_id === accountId &&
      other.amount === -transaction.amount &&
      Math.abs(daysBetween(transaction.date, other.date)) <= windowDays,
  );
}
