import {
  addDays,
  addMonths,
  addMonthsToDay,
  daysBetween,
  daysInMonth,
  lastDayOf,
  monthRange,
  monthsBetween,
  previousPeriod,
} from './dates';

describe('day arithmetic', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2029-12-31', 1)).toBe('2030-01-01');
    expect(addDays('2030-03-01', -1)).toBe('2030-02-28');
    expect(addDays('2032-03-01', -1)).toBe('2032-02-29');
  });

  it('counts the days from one date to another, negative when backwards', () => {
    expect(daysBetween('2029-12-20', '2030-01-01')).toBe(12);
    expect(daysBetween('2030-01-01', '2029-12-20')).toBe(-12);
    expect(daysBetween('2029-03-01', '2029-03-01')).toBe(0);
  });

  it('knows the length of a month, leap years included', () => {
    expect(daysInMonth('2029-02')).toBe(28);
    expect(daysInMonth('2032-02')).toBe(29);
    expect(lastDayOf('2029-12')).toBe('2029-12-31');
    expect(lastDayOf('2032-02')).toBe('2032-02-29');
  });
});

describe('month arithmetic', () => {
  it('adds months across years in both directions', () => {
    expect(addMonths('2029-11', 3)).toBe('2030-02');
    expect(addMonths('2029-01', -1)).toBe('2028-12');
    expect(addMonths('2029-06', -18)).toBe('2027-12');
    expect(addMonths('2029-06', 0)).toBe('2029-06');
  });

  it('counts whole months between two months', () => {
    expect(monthsBetween('2029-11', '2030-02')).toBe(3);
    expect(monthsBetween('2030-02', '2029-11')).toBe(-3);
  });

  it('lists every month in a range, and none when it runs backwards', () => {
    expect(monthRange('2029-11', '2030-02')).toEqual([
      '2029-11',
      '2029-12',
      '2030-01',
      '2030-02',
    ]);
    expect(monthRange('2029-11', '2029-11')).toEqual(['2029-11']);
    expect(monthRange('2030-02', '2029-11')).toEqual([]);
  });

  it('keeps the day of month, or the last day of a shorter month', () => {
    expect(addMonthsToDay('2029-01-15', 1)).toBe('2029-02-15');
    expect(addMonthsToDay('2029-01-31', 1)).toBe('2029-02-28');
    expect(addMonthsToDay('2032-01-31', 1)).toBe('2032-02-29');
    expect(addMonthsToDay('2029-11-30', 3)).toBe('2030-02-28');
    expect(addMonthsToDay('2029-03-12', 12)).toBe('2030-03-12');
  });
});

describe('previousPeriod', () => {
  it('compares whole months with the same number of whole months before', () => {
    expect(previousPeriod({ start: '2029-11-01', end: '2029-11-30' })).toEqual({
      start: '2029-10-01',
      end: '2029-10-31',
    });
    expect(previousPeriod({ start: '2029-10-01', end: '2029-12-31' })).toEqual({
      start: '2029-07-01',
      end: '2029-09-30',
    });
    expect(previousPeriod({ start: '2030-01-01', end: '2030-01-31' })).toEqual({
      start: '2029-12-01',
      end: '2029-12-31',
    });
  });

  it('compares any other range with the same number of days before', () => {
    expect(previousPeriod({ start: '2029-11-10', end: '2029-11-16' })).toEqual({
      start: '2029-11-03',
      end: '2029-11-09',
    });
    expect(previousPeriod({ start: '2029-11-02', end: '2029-11-30' })).toEqual({
      start: '2029-10-04',
      end: '2029-11-01',
    });
  });
});
