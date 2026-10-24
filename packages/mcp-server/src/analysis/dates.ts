// Calendar arithmetic on `YYYY-MM-DD` days and `YYYY-MM` months. Everything is
// done in UTC so the results never depend on the machine's time zone or on
// daylight saving changes.

const DAY_MS = 86_400_000;

function toUtc(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function addDays(day: string, days: number): string {
  return fromUtc(toUtc(day) + days * DAY_MS);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function addMonths(month: string, months: number): string {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + months;
  const nextYear = Math.floor(index / 12);
  return `${String(nextYear).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Whole months from `from` to `to`; negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/** Every month from `first` to `last`, inclusive. Empty when `last` is earlier. */
export function monthRange(first: string, last: string): string[] {
  const count = monthsBetween(first, last) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, index) =>
    addMonths(first, index),
  );
}

export function firstDayOf(month: string): string {
  return `${month}-01`;
}

export function daysInMonth(month: string): number {
  return daysBetween(firstDayOf(month), firstDayOf(addMonths(month, 1)));
}

export function lastDayOf(month: string): string {
  return addDays(firstDayOf(addMonths(month, 1)), -1);
}

export type Period = { start: string; end: string };

/**
 * The period of the same length that ends the day before `period` starts. A
 * period made of whole calendar months compares with the same number of whole
 * months before it, so "October" is compared with "September" rather than
 * with the last 31 days of September and August.
 */
export function previousPeriod({ start, end }: Period): Period {
  const wholeMonths =
    start.endsWith('-01') && end === lastDayOf(monthOf(end)) && start <= end;
  if (wholeMonths) {
    const count = monthsBetween(monthOf(start), monthOf(end)) + 1;
    const first = addMonths(monthOf(start), -count);
    return {
      start: firstDayOf(first),
      end: lastDayOf(addMonths(first, count - 1)),
    };
  }
  const length = daysBetween(start, end) + 1;
  return { start: addDays(start, -length), end: addDays(start, -1) };
}

/** The same day of month `months` later, or the last day when that month is shorter. */
export function addMonthsToDay(day: string, months: number): string {
  const month = addMonths(monthOf(day), months);
  const date = Math.min(Number(day.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(date).padStart(2, '0')}`;
}
