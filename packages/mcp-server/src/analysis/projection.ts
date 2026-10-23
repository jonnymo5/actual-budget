import type { AmountConverter } from '#actual/amounts';

import { daysInMonth, monthOf, monthRange } from './dates';
import { roundMinor } from './statistics';
import { classifyFlow, groupOf } from './transactions';
import type { AnalysisTransaction } from './transactions';

/** One expected payment or deposit from a schedule. */
export type ScheduledEvent = {
  schedule_id: string;
  name: string | null;
  date: string;
  /** Null when the schedule is not tied to an account. */
  account_id: string | null;
  /** The payee the schedule pays or is paid by, if it has one. */
  payee_id: string | null;
  /** For a transfer schedule: the account the money goes to. */
  transfer_account_id: string | null;
  /** Minor units, signed. */
  amount: number;
  /** The schedule's date has passed without it being entered; it is assumed due today. */
  overdue: boolean;
};

export type ProjectionAccount = {
  id: string;
  name: string;
  /** Minor units, as of today. */
  balance: number;
};

export type ProjectionMonth = {
  month: string;
  /** Days of this month after today that the projection covers. */
  days: number;
  /** Money in and out from schedules, major units; transfers between the accounts shown are left out. */
  scheduled_in: number;
  scheduled_out: number;
  /** Money in and out expected from everything no schedule covers. */
  baseline_in: number;
  baseline_out: number;
  net: number;
  /** Total across the accounts shown, at the end of the month. */
  ending_balance: number;
  accounts: { account_id: string; name: string; ending_balance: number }[];
};

export type AccountProjection = {
  id: string;
  name: string;
  starting_balance: number;
  ending_balance: number;
  lowest_month_end: { month: string; balance: number };
  first_negative_month: string | null;
};

export type CashFlowProjection = {
  starting_balance: number;
  months: ProjectionMonth[];
  lowest_month_end: { month: string; balance: number };
  first_negative_month: string | null;
  accounts: AccountProjection[];
  baseline: {
    /** Months of history the averages come from. */
    months_averaged: number;
    monthly_in: number;
    monthly_out: number;
    /** The biggest spending categories in the averages, major units per month. */
    top_spending: { category: string; monthly_average: number }[];
  };
};

type ProjectionOptions = {
  today: string;
  /** The last month to project, `YYYY-MM`. */
  endMonth: string;
  accounts: ProjectionAccount[];
  /** Scheduled events from today on, for any account. */
  events: ScheduledEvent[];
  /** Past transactions that no schedule covers, for the accounts shown. */
  baseline: AnalysisTransaction[];
  /** How many months `baseline` spans. */
  baselineMonths: number;
  includeBaseline: boolean;
  money: AmountConverter;
};

const TOP_SPENDING_LIMIT = 8;

// Only money crossing the edge of the accounts shown counts as "in" or "out".
// A transfer between two of them moves balances but not the totals.
function appliedDeltas(
  event: ScheduledEvent,
  shown: Set<string>,
): { accountId: string; delta: number; internal: boolean }[] {
  const internal =
    event.account_id !== null &&
    event.transfer_account_id !== null &&
    shown.has(event.account_id) &&
    shown.has(event.transfer_account_id);
  const deltas: { accountId: string; delta: number; internal: boolean }[] = [];
  if (event.account_id !== null && shown.has(event.account_id)) {
    deltas.push({ accountId: event.account_id, delta: event.amount, internal });
  }
  if (event.transfer_account_id && shown.has(event.transfer_account_id)) {
    deltas.push({
      accountId: event.transfer_account_id,
      delta: -event.amount,
      internal,
    });
  }
  return deltas;
}

export function projectCashFlow({
  today,
  endMonth,
  accounts,
  events,
  baseline,
  baselineMonths,
  includeBaseline,
  money,
}: ProjectionOptions): CashFlowProjection {
  const shown = new Set(accounts.map(account => account.id));
  const currentMonth = monthOf(today);

  // Average monthly flow per account, and which categories drive it.
  const average = new Map<string, { inflow: number; outflow: number }>();
  const categories = new Map<string, { name: string; total: number }>();
  if (includeBaseline) {
    for (const transaction of baseline) {
      const flow = classifyFlow(transaction);
      if (flow === null || !shown.has(transaction.account_id)) continue;

      const entry = average.get(transaction.account_id) ?? {
        inflow: 0,
        outflow: 0,
      };
      if (transaction.amount > 0) entry.inflow += transaction.amount;
      else entry.outflow += transaction.amount;
      average.set(transaction.account_id, entry);

      if (flow === 'spending') {
        const { key, name } = groupOf(transaction, 'category');
        const category = categories.get(key) ?? { name, total: 0 };
        category.total += transaction.amount;
        categories.set(key, category);
      }
    }
  }

  const balances = new Map(accounts.map(a => [a.id, a.balance]));
  const lowestByAccount = new Map<string, { month: string; balance: number }>();
  const firstNegative = new Map<string, string | null>(
    accounts.map(a => [a.id, null]),
  );
  const startingTotal = accounts.reduce((total, a) => total + a.balance, 0);

  const months: ProjectionMonth[] = [];
  let lowest: { month: string; balance: number } | null = null;
  let firstNegativeTotal: string | null = null;

  for (const month of monthRange(currentMonth, endMonth)) {
    const isCurrent = month === currentMonth;
    const length = daysInMonth(month);
    const days = isCurrent ? length - Number(today.slice(8, 10)) : length;
    const fraction = days / length;

    let scheduledIn = 0;
    let scheduledOut = 0;
    for (const event of events) {
      if (monthOf(event.date) !== month) continue;
      for (const { accountId, delta, internal } of appliedDeltas(
        event,
        shown,
      )) {
        balances.set(accountId, (balances.get(accountId) ?? 0) + delta);
        if (internal) continue;
        if (delta > 0) scheduledIn += delta;
        else scheduledOut += delta;
      }
    }

    let baselineIn = 0;
    let baselineOut = 0;
    for (const [accountId, { inflow, outflow }] of average) {
      const incoming = roundMinor((inflow / baselineMonths) * fraction);
      const outgoing = roundMinor((outflow / baselineMonths) * fraction);
      balances.set(
        accountId,
        (balances.get(accountId) ?? 0) + incoming + outgoing,
      );
      baselineIn += incoming;
      baselineOut += outgoing;
    }

    let total = 0;
    for (const account of accounts) {
      const balance = balances.get(account.id) ?? 0;
      total += balance;
      const low = lowestByAccount.get(account.id);
      if (!low || balance < low.balance) {
        lowestByAccount.set(account.id, { month, balance });
      }
      if (balance < 0 && firstNegative.get(account.id) === null) {
        firstNegative.set(account.id, month);
      }
    }
    if (lowest === null || total < lowest.balance) {
      lowest = { month, balance: total };
    }
    if (total < 0 && firstNegativeTotal === null) firstNegativeTotal = month;

    months.push({
      month,
      days,
      scheduled_in: money.toMajor(scheduledIn),
      scheduled_out: money.toMajor(scheduledOut),
      baseline_in: money.toMajor(baselineIn),
      baseline_out: money.toMajor(baselineOut),
      net: money.toMajor(scheduledIn + scheduledOut + baselineIn + baselineOut),
      ending_balance: money.toMajor(total),
      accounts: accounts.map(account => ({
        account_id: account.id,
        name: account.name,
        ending_balance: money.toMajor(balances.get(account.id) ?? 0),
      })),
    });
  }

  const inflow = [...average.values()].reduce((sum, a) => sum + a.inflow, 0);
  const outflow = [...average.values()].reduce((sum, a) => sum + a.outflow, 0);
  const startOfLowest = { month: currentMonth, balance: startingTotal };

  return {
    starting_balance: money.toMajor(startingTotal),
    months,
    lowest_month_end: {
      month: (lowest ?? startOfLowest).month,
      balance: money.toMajor((lowest ?? startOfLowest).balance),
    },
    first_negative_month: firstNegativeTotal,
    accounts: accounts.map(account => {
      // Every projection has at least one month, so every account has a low.
      const low = lowestByAccount.get(account.id) ?? {
        month: currentMonth,
        balance: account.balance,
      };
      return {
        id: account.id,
        name: account.name,
        starting_balance: money.toMajor(account.balance),
        ending_balance: money.toMajor(balances.get(account.id) ?? 0),
        lowest_month_end: {
          month: low.month,
          balance: money.toMajor(low.balance),
        },
        first_negative_month: firstNegative.get(account.id) ?? null,
      };
    }),
    baseline: {
      months_averaged: baselineMonths,
      monthly_in: money.toMajor(roundMinor(inflow / baselineMonths)),
      monthly_out: money.toMajor(roundMinor(outflow / baselineMonths)),
      top_spending: [...categories.values()]
        .sort((a, b) => a.total - b.total || a.name.localeCompare(b.name))
        .slice(0, TOP_SPENDING_LIMIT)
        .map(category => ({
          category: category.name,
          monthly_average: money.toMajor(
            roundMinor(category.total / baselineMonths),
          ),
        })),
    },
  };
}
