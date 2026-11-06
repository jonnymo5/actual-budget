import type { RecurConfig } from '@actual-app/core/types/models';

import { isToolError } from '#errors';

import type { Lookups, NamedId } from './lookup';

export type ScheduleRequest = {
  name: string;
  account: string;
  payee: string;
  /** Major units, negative for a payment. The lower end of a range. */
  amount: number;
  amount_match: 'exact' | 'approximate' | 'between';
  /** Major units; only for a range. */
  amount_upper?: number;
  start_date: string;
  frequency: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  days_of_month?: number[];
  weekend: 'none' | 'before' | 'after';
  end_after_occurrences?: number;
  end_date?: string;
  posts_transaction: boolean;
};

const AMOUNT_OPS = {
  exact: 'is',
  approximate: 'isapprox',
  between: 'isbetween',
} as const;

/** A schedule that passed every check and can be created as it is. */
export type ScheduleDraft = {
  name: string;
  account: NamedId;
  payee: NamedId;
  /** Minor units, as the Actual API takes them. */
  amount: number | { num1: number; num2: number };
  amountOp: (typeof AMOUNT_OPS)[keyof typeof AMOUNT_OPS];
  postsTransaction: boolean;
  /** A single date for a one-off schedule, otherwise the recurrence. */
  date: string | RecurConfig;
  warnings: string[];
};

export type SchedulePlan = { draft: ScheduleDraft } | { reason: string };

type Converter = { toMinor: (major: number) => number };

/**
 * Checks a request against everything Actual would reject (and a few things it
 * would quietly accept and get wrong), and turns it into what the API takes.
 * `takenNames` holds the names already in use; a name that passes is added, so
 * two schedules in one request cannot share a name either.
 */
export async function planSchedule(
  request: ScheduleRequest,
  {
    lookups,
    amounts,
    takenNames,
  }: { lookups: Lookups; amounts: Converter; takenNames: Set<string> },
): Promise<SchedulePlan> {
  const name = request.name.trim();
  if (name === '') return { reason: 'name cannot be empty' };
  if (takenNames.has(name)) {
    return {
      reason: `there is already a schedule named "${name}"; schedule names must be unique`,
    };
  }

  if (request.amount === 0) {
    return {
      reason:
        'amount cannot be 0: use a negative amount for a payment, a positive one for a deposit',
    };
  }
  if (request.amount_match === 'between') {
    if (request.amount_upper === undefined) {
      return {
        reason:
          'amount_match "between" needs amount_upper, the other end of the range',
      };
    }
    if (request.amount_upper <= request.amount) {
      return {
        reason:
          'amount_upper must be greater than amount: for a payment range give the larger payment as a more negative amount (e.g. amount -60, amount_upper -40)',
      };
    }
  } else if (request.amount_upper !== undefined) {
    return { reason: 'amount_upper is only for amount_match "between"' };
  }

  if (request.end_after_occurrences !== undefined && request.end_date) {
    return {
      reason: 'give either end_after_occurrences or end_date, not both',
    };
  }
  if (request.end_date && request.end_date < request.start_date) {
    return { reason: 'end_date is before start_date' };
  }

  const repeats = request.frequency !== 'once';
  if (!repeats) {
    const ignored = [
      request.interval !== 1 ? 'interval' : null,
      request.days_of_month ? 'days_of_month' : null,
      request.weekend !== 'none' ? 'weekend' : null,
      request.end_after_occurrences !== undefined
        ? 'end_after_occurrences'
        : null,
      request.end_date ? 'end_date' : null,
    ].filter((field): field is string => field !== null);
    if (ignored.length > 0) {
      return {
        reason: `${ignored.join(', ')} only apply to a repeating schedule; frequency is "once"`,
      };
    }
  }

  const days = [...new Set(request.days_of_month ?? [])];
  if (days.length > 0 && request.frequency !== 'monthly') {
    return { reason: 'days_of_month only applies to a monthly schedule' };
  }
  if (days.some(day => day === 0 || day < -1 || day > 31)) {
    return {
      reason:
        'days_of_month takes days 1 to 31, or -1 for the last day of the month',
    };
  }

  let account: NamedId;
  let payee: NamedId;
  try {
    account = await lookups.account(request.account);
    payee = await lookups.payee(request.payee, { allowTransfers: true });
  } catch (error) {
    if (isToolError(error)) {
      return { reason: (error as Error).message };
    }
    throw error;
  }

  const warnings: string[] = [];
  if (days.some(day => day > 28)) {
    warnings.push(
      `${name}: months with fewer days than the chosen day skip that month. Use -1 for the last day of every month.`,
    );
  }

  const config: RecurConfig = {
    frequency: request.frequency === 'once' ? 'monthly' : request.frequency,
    interval: request.interval,
    start: request.start_date,
    patterns: days
      .sort((a, b) => a - b)
      .map(value => ({ value, type: 'day' as const })),
    skipWeekend: request.weekend !== 'none',
    weekendSolveMode: request.weekend === 'before' ? 'before' : 'after',
    ...(request.end_after_occurrences !== undefined
      ? {
          endMode: 'after_n_occurrences' as const,
          endOccurrences: request.end_after_occurrences,
        }
      : request.end_date
        ? { endMode: 'on_date' as const, endDate: request.end_date }
        : { endMode: 'never' as const }),
  };

  takenNames.add(name);
  const lower = amounts.toMinor(request.amount);
  return {
    draft: {
      name,
      account,
      payee,
      amount:
        request.amount_match === 'between'
          ? { num1: lower, num2: amounts.toMinor(request.amount_upper ?? 0) }
          : lower,
      amountOp: AMOUNT_OPS[request.amount_match],
      postsTransaction: request.posts_transaction,
      date: repeats ? config : request.start_date,
      warnings,
    },
  };
}
