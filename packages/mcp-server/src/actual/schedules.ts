import { z } from 'zod';

import type { ActualContext } from './session';

export type Recurrence = {
  /** Plain-language form, e.g. "every 2 weeks, starting 2030-02-04". */
  description: string;
  frequency: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  start: string;
  /** When the recurrence stops: a date, "after N occurrences", or null. */
  ends: string | null;
};

export type ScheduleSummary = {
  id: string;
  name: string | null;
  next_date: string | null;
  completed: boolean;
  /** True when the schedule enters the transaction by itself on its date. */
  posts_transaction: boolean;
  payee_id: string | null;
  payee: string | null;
  account_id: string | null;
  account: string | null;
  /** Major units, negative for payments. The lower bound for a range. */
  amount: number | null;
  /** The upper bound, only when `amount_match` is "between". */
  amount_upper: number | null;
  amount_match: 'exact' | 'approximate' | 'between' | null;
  recurrence: Recurrence;
};

export const recurSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().nullish(),
  patterns: z
    .array(z.object({ value: z.number(), type: z.string() }))
    .nullish(),
  skipWeekend: z.boolean().nullish(),
  start: z.string(),
  endMode: z.enum(['never', 'after_n_occurrences', 'on_date']).nullish(),
  endOccurrences: z.number().nullish(),
  endDate: z.string().nullish(),
  weekendSolveMode: z.enum(['before', 'after']).nullish(),
});

export const rawScheduleSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  next_date: z.string().nullish(),
  completed: z.boolean().nullish(),
  posts_transaction: z.boolean().nullish(),
  payee: z.string().nullish(),
  account: z.string().nullish(),
  amount: z
    .union([z.number(), z.object({ num1: z.number(), num2: z.number() })])
    .nullish(),
  amountOp: z.string().nullish(),
  date: z.union([z.string(), recurSchema]),
});

const UNITS = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
} as const;

const WEEKDAYS: Record<string, string> = {
  SU: 'Sunday',
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
};

function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function describePattern(pattern: {
  value: number;
  type: string;
}): string | null {
  if (pattern.type === 'day') {
    return pattern.value === -1 ? 'the last day' : `day ${pattern.value}`;
  }
  const weekday = WEEKDAYS[pattern.type];
  if (!weekday) return null;
  return `the ${pattern.value === -1 ? 'last' : ordinal(pattern.value)} ${weekday}`;
}

export function describeRecurrence(
  date: string | z.output<typeof recurSchema>,
): Recurrence {
  if (typeof date === 'string') {
    return {
      description: `once, on ${date}`,
      frequency: 'once',
      interval: 1,
      start: date,
      ends: null,
    };
  }

  const interval = date.interval ?? 1;
  const unit = UNITS[date.frequency];
  const every = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
  const patterns = (date.patterns ?? [])
    .map(describePattern)
    .filter((text): text is string => text !== null);

  let ends: string | null = null;
  if (date.endMode === 'on_date' && date.endDate) {
    ends = date.endDate;
  } else if (date.endMode === 'after_n_occurrences' && date.endOccurrences) {
    ends = `after ${date.endOccurrences} occurrences`;
  }

  const parts = [
    every,
    ...(patterns.length > 0 ? [`on ${patterns.join(' and ')}`] : []),
    `starting ${date.start}`,
    ...(ends
      ? [ends.startsWith('after') ? `ending ${ends}` : `until ${ends}`]
      : []),
    ...(date.skipWeekend
      ? [
          `moved to the ${date.weekendSolveMode === 'before' ? 'previous' : 'next'} weekday if it falls on a weekend`,
        ]
      : []),
  ];

  return {
    description: parts.join(', '),
    frequency: date.frequency,
    interval,
    start: date.start,
    ends,
  };
}

const AMOUNT_MATCH: Record<string, ScheduleSummary['amount_match']> = {
  is: 'exact',
  isapprox: 'approximate',
  isbetween: 'between',
};

export async function listSchedules(
  ctx: ActualContext,
  { includeCompleted }: { includeCompleted: boolean },
): Promise<ScheduleSummary[]> {
  const schedules = z
    .array(rawScheduleSchema)
    .parse(await ctx.api.getSchedules());
  const accounts = await ctx.api.getAccounts();
  const payees = await ctx.api.getPayees();
  const accountNames = new Map(
    accounts.map(account => [account.id, account.name]),
  );
  const payeeNames = new Map(payees.map(payee => [payee.id, payee.name]));
  const { toMajor } = ctx.amounts;

  return schedules
    .filter(schedule => includeCompleted || !schedule.completed)
    .map(schedule => {
      const range =
        typeof schedule.amount === 'object' ? schedule.amount : null;
      const exact =
        typeof schedule.amount === 'number' ? schedule.amount : null;
      const lower = range ? range.num1 : exact;
      return {
        id: schedule.id,
        name: schedule.name ?? null,
        next_date: schedule.next_date ?? null,
        completed: Boolean(schedule.completed),
        posts_transaction: Boolean(schedule.posts_transaction),
        payee_id: schedule.payee ?? null,
        payee: schedule.payee ? (payeeNames.get(schedule.payee) ?? null) : null,
        account_id: schedule.account ?? null,
        account: schedule.account
          ? (accountNames.get(schedule.account) ?? null)
          : null,
        amount: lower === null ? null : toMajor(lower),
        amount_upper: range ? toMajor(range.num2) : null,
        amount_match: AMOUNT_MATCH[schedule.amountOp ?? ''] ?? null,
        recurrence: describeRecurrence(schedule.date),
      };
    })
    .sort((a, b) => {
      if (a.next_date === b.next_date) {
        return (a.name ?? '').localeCompare(b.name ?? '');
      }
      if (a.next_date === null) return 1;
      if (b.next_date === null) return -1;
      return a.next_date.localeCompare(b.next_date);
    });
}
