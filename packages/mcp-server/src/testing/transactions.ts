import type { AmountConverter } from '#actual/amounts';
import type { AnalysisTransaction } from '#analysis/transactions';

/** Dollars without the Actual API: the analysis only needs the conversion functions. */
export const usd: AmountConverter = {
  decimalPlaces: 2,
  toMajor: minor => minor / 100 + 0,
  toMinor: major => Math.round(major * 100) + 0,
  format: major => major.toFixed(2),
};

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
let counter = 0;

type Extra = Partial<AnalysisTransaction>;

function build(
  date: string,
  minor: number,
  payee: string | null,
  category: string | null,
  incomeCategory: boolean,
  extra: Extra,
): AnalysisTransaction {
  counter++;
  return {
    id: `t${String(counter).padStart(5, '0')}`,
    date,
    amount: minor,
    account_id: 'checking',
    account: 'Checking',
    account_off_budget: false,
    payee_id: payee === null ? null : slug(payee),
    payee,
    category_id: category === null ? null : slug(category),
    category,
    category_group: category === null ? null : 'Everyday',
    category_is_income: incomeCategory,
    is_transfer: false,
    ...extra,
  };
}

/** A purchase of `dollars` (given as a positive number) on `date`. */
export function spent(
  date: string,
  dollars: number,
  payee: string | null,
  category: string | null = null,
  extra: Extra = {},
) {
  return build(date, -Math.round(dollars * 100), payee, category, false, extra);
}

/** Money received, filed under an income category. */
export function earned(
  date: string,
  dollars: number,
  payee: string | null,
  category: string | null = 'Salary',
  extra: Extra = {},
) {
  return build(date, Math.round(dollars * 100), payee, category, true, {
    category_group: 'Income',
    ...extra,
  });
}

/** A refund: money back into a spending category. */
export function refunded(
  date: string,
  dollars: number,
  payee: string | null,
  category: string,
) {
  return build(date, Math.round(dollars * 100), payee, category, false, {});
}

/** The same purchase repeated on each of `dates`. */
export function repeat(
  dates: string[],
  dollars: number | number[],
  payee: string,
  category: string | null = null,
  extra: Extra = {},
) {
  return dates.map((date, index) =>
    spent(
      date,
      Array.isArray(dollars) ? dollars[index] : dollars,
      payee,
      category,
      extra,
    ),
  );
}

/** `YYYY-MM-DD` dates `step` days apart, `count` of them from `start`. */
export function everyDays(start: string, step: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const ms = Date.parse(`${start}T00:00:00Z`) + index * step * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  });
}

/** The given day of each month from `first` (`YYYY-MM`) for `count` months. */
export function monthly(first: string, day: number, count: number) {
  const [year, month] = first.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const at = year * 12 + (month - 1) + index;
    return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  });
}
