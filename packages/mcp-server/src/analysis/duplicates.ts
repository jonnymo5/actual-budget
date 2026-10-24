import { daysBetween } from './dates';

/** What duplicate detection needs to know about a transaction of one account. */
export type DuplicateCandidate = {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Integer minor units, signed. */
  amount: number;
  payee_id: string | null;
  payee: string | null;
  imported_id: string | null;
  notes: string | null;
};

export type DuplicateGroup = {
  /** Integer minor units, signed: the amount each of the transactions has. */
  amount: number;
  payee: string | null;
  /** Oldest first. At least two. */
  transactions: DuplicateCandidate[];
};

// Two transactions the bank reported under different ids are two transactions,
// however alike they look. Only a pair where at least one side has no id (a
// manual entry, or an earlier import) can be the same transaction twice.
function maybeSame(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  return !(a.imported_id && b.imported_id && a.imported_id !== b.imported_id);
}

/**
 * Groups of transactions that may be one transaction entered twice: the same
 * payee and amount within `windowDays` of each other. It is a list of
 * suspects. Two coffees on one day look exactly like a double entry.
 */
export function findDuplicateGroups(
  transactions: DuplicateCandidate[],
  { windowDays }: { windowDays: number },
): DuplicateGroup[] {
  const byKey = new Map<string, DuplicateCandidate[]>();
  for (const transaction of transactions) {
    if (!transaction.payee_id) continue;
    const key = `${transaction.payee_id}|${transaction.amount}`;
    const list = byKey.get(key) ?? [];
    list.push(transaction);
    byKey.set(key, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    );

    // Join every pair that could be the same transaction, then take the
    // connected pieces.
    const parent = sorted.map((_, index) => index);
    const root = (index: number): number => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    for (let later = 1; later < sorted.length; later++) {
      for (let earlier = 0; earlier < later; earlier++) {
        if (
          daysBetween(sorted[earlier].date, sorted[later].date) <= windowDays &&
          maybeSame(sorted[earlier], sorted[later])
        ) {
          parent[root(later)] = root(earlier);
        }
      }
    }

    const pieces = new Map<number, DuplicateCandidate[]>();
    sorted.forEach((transaction, index) => {
      const piece = pieces.get(root(index)) ?? [];
      piece.push(transaction);
      pieces.set(root(index), piece);
    });
    for (const piece of pieces.values()) {
      if (piece.length < 2) continue;
      groups.push({
        amount: piece[0].amount,
        payee: piece[0].payee,
        transactions: piece,
      });
    }
  }

  return groups.sort(
    (a, b) =>
      a.transactions[0].date.localeCompare(b.transactions[0].date) ||
      a.transactions[0].id.localeCompare(b.transactions[0].id),
  );
}

/** How much the extra copies add up to, in minor units: all but one of each group. */
export function extraCopiesTotal(groups: DuplicateGroup[]): number {
  return groups.reduce(
    (sum, group) => sum + group.amount * (group.transactions.length - 1),
    0,
  );
}
