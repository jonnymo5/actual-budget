import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';

import { listScheduledEvents } from './schedule-events';
import type { ActualContext } from './session';

// Schedules start in 2030 or later so that the next date Actual works out from
// the real clock is the start date itself, whichever day the tests run. 2030-01-01
// is a Tuesday.
let budget: TestBudget;
let checking: string;
let reserve: string;

type Recurrence = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  start: string;
  interval?: number;
  patterns?: {
    value: number;
    type: 'day' | 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';
  }[];
  skipWeekend?: boolean;
  weekendSolveMode?: 'before' | 'after';
  endMode?: 'never' | 'after_n_occurrences' | 'on_date';
  endOccurrences?: number;
  endDate?: string;
};

function recurring(config: Recurrence) {
  return {
    interval: 1,
    patterns: [],
    skipWeekend: false,
    weekendSolveMode: 'after' as const,
    endMode: 'never' as const,
    ...config,
  };
}

async function schedule(
  ctx: ActualContext,
  name: string,
  date: string | ReturnType<typeof recurring>,
  extra: Record<string, unknown> = {},
) {
  return ctx.api.createSchedule({
    name,
    posts_transaction: false,
    account: checking,
    amount: -10_000,
    amountOp: 'is',
    date,
    ...extra,
  });
}

beforeAll(async () => {
  budget = await createTestBudget();
  await budget.use(async ctx => {
    checking = (await ctx.api.getAccounts())[0].id;
    reserve = await ctx.api.createAccount({ name: 'Reserve' });
    const toReserve = (await ctx.api.getPayees()).find(
      payee => payee.transfer_acct === reserve,
    );
    if (!toReserve) throw new Error('no transfer payee for Reserve');

    // Saturday 2030-03-02, with the weekend rule pointing each way.
    await schedule(
      ctx,
      'After weekend',
      recurring({
        frequency: 'monthly',
        start: '2030-03-02',
        skipWeekend: true,
        weekendSolveMode: 'after',
      }),
    );
    await schedule(
      ctx,
      'Before weekend',
      recurring({
        frequency: 'monthly',
        start: '2030-03-02',
        skipWeekend: true,
        weekendSolveMode: 'before',
      }),
    );
    await schedule(
      ctx,
      'Fortnightly',
      recurring({
        frequency: 'weekly',
        interval: 2,
        start: '2030-02-04',
      }),
    );
    await schedule(
      ctx,
      'Three times',
      recurring({
        frequency: 'monthly',
        start: '2030-01-10',
        endMode: 'after_n_occurrences',
        endOccurrences: 3,
      }),
    );
    await schedule(
      ctx,
      'Until the 19th',
      recurring({
        frequency: 'weekly',
        start: '2030-02-05',
        endMode: 'on_date',
        endDate: '2030-02-19',
      }),
    );
    await schedule(
      ctx,
      'Last day',
      recurring({
        frequency: 'monthly',
        start: '2030-01-31',
        patterns: [{ value: -1, type: 'day' }],
      }),
    );
    await schedule(
      ctx,
      'Second Tuesday',
      recurring({
        frequency: 'monthly',
        start: '2030-01-01',
        patterns: [{ value: 2, type: 'TU' }],
      }),
    );
    await schedule(ctx, 'One time', '2030-06-01');
    await schedule(ctx, 'Overdue', '2025-01-01');
    await schedule(ctx, 'Range', '2030-07-01', {
      amount: { num1: -6000, num2: -4000 },
      amountOp: 'isbetween',
    });
    await schedule(ctx, 'Transfer', '2030-07-02', {
      payee: toReserve.id,
      amount: -25_000,
    });

    const finished = await schedule(ctx, 'Finished', '2030-08-01');
    if (!ctx.api.internal) throw new Error('the Actual API is not initialised');
    await ctx.api.internal.send('schedule/update', {
      schedule: { id: finished, completed: true },
    });
  });
});

afterAll(async () => {
  await budget.dispose();
});

async function datesOf(name: string, from: string, to: string) {
  const events = await budget.use(ctx =>
    listScheduledEvents(ctx, { from, to }),
  );
  return events.filter(event => event.name === name).map(event => event.date);
}

describe('listScheduledEvents', () => {
  it('moves a payment off the weekend the way the schedule says', async () => {
    const range = ['2030-03-01', '2030-06-30'] as const;

    // Saturday 2 March goes to Monday 4th; Sunday 2 June to Monday the 3rd.
    expect(await datesOf('After weekend', ...range)).toEqual([
      '2030-03-04',
      '2030-04-02',
      '2030-05-02',
      '2030-06-03',
    ]);
    // Or back to the Friday before.
    expect(await datesOf('Before weekend', ...range)).toEqual([
      '2030-03-01',
      '2030-04-02',
      '2030-05-02',
      '2030-05-31',
    ]);
  });

  it('repeats every other week', async () => {
    expect(await datesOf('Fortnightly', '2030-02-01', '2030-03-15')).toEqual([
      '2030-02-04',
      '2030-02-18',
      '2030-03-04',
    ]);
  });

  it('stops after the number of occurrences, or on the end date', async () => {
    expect(await datesOf('Three times', '2030-01-01', '2030-12-31')).toEqual([
      '2030-01-10',
      '2030-02-10',
      '2030-03-10',
    ]);
    expect(await datesOf('Until the 19th', '2030-02-01', '2030-12-31')).toEqual(
      ['2030-02-05', '2030-02-12', '2030-02-19'],
    );
  });

  it('follows day-of-month and weekday patterns', async () => {
    expect(await datesOf('Last day', '2030-01-01', '2030-03-31')).toEqual([
      '2030-01-31',
      '2030-02-28',
      '2030-03-31',
    ]);
    expect(await datesOf('Second Tuesday', '2030-01-01', '2030-03-31')).toEqual(
      ['2030-01-08', '2030-02-12', '2030-03-12'],
    );
  });

  it('includes a one-time schedule only inside the range', async () => {
    expect(await datesOf('One time', '2030-05-01', '2030-06-30')).toEqual([
      '2030-06-01',
    ]);
    expect(await datesOf('One time', '2030-01-01', '2030-05-31')).toEqual([]);
  });

  it('treats a schedule whose date has passed as due on the first day asked for', async () => {
    const events = await budget.use(ctx =>
      listScheduledEvents(ctx, { from: '2025-02-01', to: '2025-12-31' }),
    );
    const overdue = events.find(event => event.name === 'Overdue');

    expect(overdue).toMatchObject({ date: '2025-02-01', overdue: true });
  });

  it('only calls the occurrence the schedule is stuck on overdue', async () => {
    // Actual says the fortnightly schedule's next date is 4 February. Asked
    // from 1 March, it is behind: that one payment is due now, the one on the
    // 18th that it skipped over is not still to come, and the ones after are
    // ordinary.
    const events = await budget.use(ctx =>
      listScheduledEvents(ctx, { from: '2030-03-01', to: '2030-03-31' }),
    );

    expect(
      events
        .filter(event => event.name === 'Fortnightly')
        .map(event => [event.date, event.overdue]),
    ).toEqual([
      ['2030-03-01', true],
      ['2030-03-04', false],
      ['2030-03-18', false],
    ]);
  });

  it('takes the middle of a range of amounts', async () => {
    const events = await budget.use(ctx =>
      listScheduledEvents(ctx, { from: '2030-07-01', to: '2030-07-01' }),
    );
    expect(events.find(event => event.name === 'Range')?.amount).toBe(-5000);
  });

  it('says which account a transfer goes to', async () => {
    const events = await budget.use(ctx =>
      listScheduledEvents(ctx, { from: '2030-07-02', to: '2030-07-02' }),
    );

    expect(events.filter(event => event.name === 'Transfer')).toEqual([
      expect.objectContaining({
        date: '2030-07-02',
        account_id: checking,
        transfer_account_id: reserve,
        amount: -25_000,
        overdue: false,
      }),
    ]);
  });

  it('leaves out completed schedules', async () => {
    expect(await datesOf('Finished', '2030-08-01', '2030-08-31')).toEqual([]);
  });

  it('lists events soonest first', async () => {
    const events = await budget.use(ctx =>
      listScheduledEvents(ctx, { from: '2030-01-01', to: '2030-02-28' }),
    );
    const dates = events.map(event => event.date);

    expect(dates).toEqual([...dates].sort());
    expect(dates.length).toBeGreaterThan(5);
  });
});
