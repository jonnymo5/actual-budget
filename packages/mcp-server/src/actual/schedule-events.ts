import { RSchedule } from '@actual-app/core/server/util/rschedule';
import { z } from 'zod';

import { addDays } from '#analysis/dates';
import type { ScheduledEvent } from '#analysis/projection';

import type { recurSchema } from './schedules';
import { rawScheduleSchema } from './schedules';
import type { ActualContext } from './session';

type RecurConfig = z.output<typeof recurSchema>;

// Weekend adjustments can move a payment by up to two days, so the engine is
// asked for occurrences that far before the schedule's next date.
const WEEKEND_SHIFT_DAYS = 3;

// Days are handled as local-time calendar days, as Actual does, and pinned to
// noon so a daylight saving change can never push one onto the next day.
function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, 12);
}

function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function moveOffWeekend(date: Date, mode: 'before' | 'after'): Date {
  const weekday = date.getDay();
  if (weekday !== 0 && weekday !== 6) return date;
  // After: the next Monday. Before: the Friday before.
  const shift =
    mode === 'after' ? (weekday === 6 ? 2 : 1) : weekday === 6 ? -1 : -2;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + shift,
    12,
  );
}

// The same mapping Actual uses to turn a schedule's recurrence into the rules
// its scheduling engine understands.
function toRules(config: RecurConfig) {
  const base = {
    start: parseDay(config.start),
    frequency: config.frequency.toUpperCase() as Uppercase<
      RecurConfig['frequency']
    >,
    byHourOfDay: [12],
    ...(config.interval ? { interval: config.interval } : {}),
    ...(config.endMode === 'after_n_occurrences' && config.endOccurrences
      ? { count: config.endOccurrences }
      : {}),
    ...(config.endMode === 'on_date' && config.endDate
      ? { end: parseDay(config.endDate) }
      : {}),
  };

  const patterns = config.patterns ?? [];
  if (config.frequency !== 'monthly' || patterns.length === 0) return [base];

  const days = patterns.filter(pattern => pattern.type === 'day');
  const weekdays = patterns.filter(pattern => pattern.type !== 'day');
  return [
    ...(days.length > 0
      ? [{ ...base, byDayOfMonth: days.map(pattern => pattern.value) }]
      : []),
    ...(weekdays.length > 0
      ? [
          {
            ...base,
            byDayOfWeek: weekdays.map(
              pattern =>
                [pattern.type.slice(0, 2).toUpperCase(), pattern.value] as [
                  string,
                  number,
                ],
            ),
          },
        ]
      : []),
  ];
}

function occurrenceDates(
  date: string | RecurConfig,
  nextDate: string,
  to: string,
): string[] {
  if (typeof date === 'string') return nextDate <= to ? [nextDate] : [];

  const schedule = new RSchedule({
    rrules: toRules(date),
    data: {
      skipWeekend: date.skipWeekend,
      weekendSolve: date.weekendSolveMode,
    },
  });
  const mode = date.weekendSolveMode ?? 'after';
  return schedule
    .occurrences({
      start: parseDay(addDays(nextDate, -WEEKEND_SHIFT_DAYS)),
      end: parseDay(addDays(to, WEEKEND_SHIFT_DAYS)),
    })
    .toArray()
    .map(occurrence =>
      formatDay(
        date.skipWeekend
          ? moveOffWeekend(occurrence.date, mode)
          : occurrence.date,
      ),
    )
    .filter(day => day >= nextDate && day <= to);
}

/**
 * The payments and deposits the schedules expect from `from` through `to`
 * (inclusive), in minor units. A schedule whose date has passed without being
 * entered is assumed due on `from`. Completed schedules and schedules that
 * never come due again are left out.
 */
export async function listScheduledEvents(
  ctx: ActualContext,
  { from, to }: { from: string; to: string },
): Promise<ScheduledEvent[]> {
  const schedules = z
    .array(rawScheduleSchema)
    .parse(await ctx.api.getSchedules());
  const payees = await ctx.api.getPayees();
  const transferTargets = new Map(
    payees.flatMap(payee =>
      payee.transfer_acct ? [[payee.id, payee.transfer_acct] as const] : [],
    ),
  );

  const events: ScheduledEvent[] = [];
  for (const schedule of schedules) {
    if (schedule.completed || !schedule.next_date) continue;

    const amount =
      typeof schedule.amount === 'object' && schedule.amount !== null
        ? Math.round((schedule.amount.num1 + schedule.amount.num2) / 2)
        : (schedule.amount ?? 0);
    const overdue = schedule.next_date < from;
    for (const date of occurrenceDates(schedule.date, schedule.next_date, to)) {
      // Only the occurrence the schedule is stuck on can be overdue; the
      // earlier ones it skipped over are not payments still to come.
      if (date < from && date !== schedule.next_date) continue;
      events.push({
        schedule_id: schedule.id,
        name: schedule.name ?? null,
        // An overdue payment is expected any day now, not in the past.
        date: date < from ? from : date,
        account_id: schedule.account ?? null,
        payee_id: schedule.payee ?? null,
        transfer_account_id: schedule.payee
          ? (transferTargets.get(schedule.payee) ?? null)
          : null,
        amount,
        overdue: overdue && date === schedule.next_date,
      });
    }
  }

  return events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.name ?? '').localeCompare(b.name ?? '') ||
      a.schedule_id.localeCompare(b.schedule_id),
  );
}
