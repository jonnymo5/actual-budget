import {
  createAmountConverter,
  isValidIsoDate,
  isValidIsoMonth,
  todayIso,
} from './amounts';

describe('createAmountConverter', () => {
  const usd = createAmountConverter('USD');

  it('converts minor units to major units and back', () => {
    expect(usd.toMajor(123456)).toBe(1234.56);
    expect(usd.toMinor(1234.56)).toBe(123456);
  });

  it('round-trips every cent value, including ones floats get wrong', () => {
    // 19.99 * 100 === 1998.9999999999998 in floating point.
    expect(usd.toMinor(19.99)).toBe(1999);
    expect(usd.toMinor(0.1 + 0.2)).toBe(30);

    for (const minor of [0, 1, 7, 99, 1999, 100000, 99999999, -1, -1999]) {
      expect(usd.toMinor(usd.toMajor(minor))).toBe(minor);
    }
  });

  it('keeps the sign: spending is negative', () => {
    expect(usd.toMajor(-8550)).toBe(-85.5);
    expect(usd.toMinor(-85.5)).toBe(-8550);
  });

  it('never produces negative zero', () => {
    expect(Object.is(usd.toMinor(-0.001), 0)).toBe(true);
  });

  it('formats with the currency precision', () => {
    expect(usd.format(-12.3)).toBe('-12.30');
    expect(usd.format(5)).toBe('5.00');
  });

  it('follows the budget currency when it has no minor unit', () => {
    const jpy = createAmountConverter('JPY');
    expect(jpy.decimalPlaces).toBe(0);
    expect(jpy.toMajor(1500)).toBe(1500);
    expect(jpy.toMinor(1500)).toBe(1500);
    expect(jpy.format(1500)).toBe('1500');
  });

  it('defaults to two decimal places when no currency is set', () => {
    expect(createAmountConverter().decimalPlaces).toBe(2);
    expect(createAmountConverter('').decimalPlaces).toBe(2);
    expect(createAmountConverter(undefined).toMajor(250)).toBe(2.5);
  });
});

describe('isValidIsoDate', () => {
  it('accepts real calendar dates', () => {
    expect(isValidIsoDate('2026-10-23')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });

  it.each([
    ['not a date', 'yesterday'],
    ['wrong separators', '2026/10/23'],
    ['no leading zeros', '2026-1-5'],
    ['month 13', '2026-13-01'],
    ['Feb 30', '2026-02-30'],
    ['Feb 29 in a non-leap year', '2026-02-29'],
    ['a datetime', '2026-10-23T00:00:00Z'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isValidIsoDate(value)).toBe(false);
  });
});

describe('isValidIsoMonth', () => {
  it('accepts YYYY-MM only', () => {
    expect(isValidIsoMonth('2026-10')).toBe(true);
    expect(isValidIsoMonth('2026-13')).toBe(false);
    expect(isValidIsoMonth('2026-10-01')).toBe(false);
    expect(isValidIsoMonth('2026-1')).toBe(false);
  });
});

describe('todayIso', () => {
  it('formats the local calendar date', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(todayIso(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });
});
