import { describeRecurrence } from './schedules';

describe('describeRecurrence', () => {
  it('describes a one-off schedule by its date', () => {
    expect(describeRecurrence('2030-06-01')).toEqual({
      description: 'once, on 2030-06-01',
      frequency: 'once',
      interval: 1,
      start: '2030-06-01',
      ends: null,
    });
  });

  it.each([
    ['daily', 1, 'every day'],
    ['weekly', 1, 'every week'],
    ['monthly', 1, 'every month'],
    ['yearly', 1, 'every year'],
    ['daily', 3, 'every 3 days'],
    ['weekly', 2, 'every 2 weeks'],
    ['monthly', 6, 'every 6 months'],
    ['yearly', 2, 'every 2 years'],
  ] as const)(
    'says "every" for %s with interval %s',
    (frequency, interval, every) => {
      expect(
        describeRecurrence({ frequency, interval, start: '2030-01-15' }),
      ).toMatchObject({
        description: `${every}, starting 2030-01-15`,
        frequency,
        interval,
        start: '2030-01-15',
      });
    },
  );

  it('treats a missing interval as 1', () => {
    expect(
      describeRecurrence({ frequency: 'weekly', start: '2030-01-15' }),
    ).toMatchObject({
      interval: 1,
      description: 'every week, starting 2030-01-15',
    });
  });

  it('names the days of the month a monthly schedule falls on', () => {
    const { description } = describeRecurrence({
      frequency: 'monthly',
      start: '2030-01-01',
      patterns: [
        { value: 1, type: 'day' },
        { value: 15, type: 'day' },
        { value: -1, type: 'day' },
      ],
    });

    expect(description).toBe(
      'every month, on day 1 and day 15 and the last day, starting 2030-01-01',
    );
  });

  it.each([
    [1, 'FR', 'the 1st Friday'],
    [2, 'MO', 'the 2nd Monday'],
    [3, 'WE', 'the 3rd Wednesday'],
    [4, 'SU', 'the 4th Sunday'],
    [-1, 'TH', 'the last Thursday'],
  ])('names the weekday occurrence %s %s', (value, type, expected) => {
    const { description } = describeRecurrence({
      frequency: 'monthly',
      start: '2030-01-01',
      patterns: [{ value, type }],
    });

    expect(description).toBe(
      `every month, on ${expected}, starting 2030-01-01`,
    );
  });

  it('ignores a pattern it does not understand instead of guessing', () => {
    const { description } = describeRecurrence({
      frequency: 'monthly',
      start: '2030-01-01',
      patterns: [{ value: 1, type: 'XX' }],
    });

    expect(description).toBe('every month, starting 2030-01-01');
  });

  it('says when a schedule stops', () => {
    expect(
      describeRecurrence({
        frequency: 'monthly',
        start: '2030-01-01',
        endMode: 'on_date',
        endDate: '2031-01-01',
      }),
    ).toMatchObject({
      description: 'every month, starting 2030-01-01, until 2031-01-01',
      ends: '2031-01-01',
    });

    expect(
      describeRecurrence({
        frequency: 'monthly',
        start: '2030-01-01',
        endMode: 'after_n_occurrences',
        endOccurrences: 12,
      }),
    ).toMatchObject({
      description:
        'every month, starting 2030-01-01, ending after 12 occurrences',
      ends: 'after 12 occurrences',
    });
  });

  it('reports no end for a schedule that never stops', () => {
    expect(
      describeRecurrence({
        frequency: 'monthly',
        start: '2030-01-01',
        endMode: 'never',
      }).ends,
    ).toBeNull();
  });

  it.each([
    ['before', 'previous'],
    ['after', 'next'],
    [undefined, 'next'],
  ] as const)('explains how weekends are handled (%s)', (mode, weekday) => {
    const { description } = describeRecurrence({
      frequency: 'monthly',
      start: '2030-01-01',
      skipWeekend: true,
      weekendSolveMode: mode,
    });

    expect(description).toBe(
      `every month, starting 2030-01-01, moved to the ${weekday} weekday if it falls on a weekend`,
    );
  });
});
