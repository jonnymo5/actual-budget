import { earned, spent, usd } from '#testing/transactions';

import { projectCashFlow } from './projection';
import type { ProjectionAccount, ScheduledEvent } from './projection';

// Today is 2029-12-20, so December has 11 days left of 31. Amounts below are
// minor units (cents): 100000 is 1,000.00.
const TODAY = '2029-12-20';
const checking: ProjectionAccount = {
  id: 'checking',
  name: 'Checking',
  balance: 100_000,
};
const savings: ProjectionAccount = {
  id: 'savings',
  name: 'Savings',
  balance: 500_000,
};

function event(overrides: Partial<ScheduledEvent>): ScheduledEvent {
  return {
    schedule_id: 's',
    name: null,
    date: '2030-01-01',
    account_id: 'checking',
    payee_id: null,
    transfer_account_id: null,
    amount: 0,
    overdue: false,
    ...overrides,
  };
}

function project(
  overrides: Partial<Parameters<typeof projectCashFlow>[0]> = {},
) {
  return projectCashFlow({
    today: TODAY,
    endMonth: '2030-02',
    accounts: [checking, savings],
    events: [],
    baseline: [],
    baselineMonths: 3,
    includeBaseline: true,
    money: usd,
    ...overrides,
  });
}

// Pay of 2,500 each month and 300 of groceries, over three months: on
// average 2,500 in and 300 out a month, all in Checking.
const averaged = [
  ...['2029-09-01', '2029-10-01', '2029-11-01'].map(date =>
    earned(date, 2500, 'Boss'),
  ),
  ...['2029-09-10', '2029-10-10', '2029-11-10'].map(date =>
    spent(date, 300, 'Costco', 'Food'),
  ),
];
const events = [
  event({ name: 'Late fee', date: TODAY, amount: -5000, overdue: true }),
  event({ name: 'Rent', date: '2030-01-01', amount: -150_000 }),
  event({
    name: 'To savings',
    date: '2030-01-15',
    amount: -20_000,
    transfer_account_id: 'savings',
  }),
  event({ name: 'Payroll', date: '2030-02-10', amount: 250_000 }),
];

describe('projectCashFlow', () => {
  it('adds scheduled items and the trailing average to each month, per account', () => {
    const result = project({ events, baseline: averaged });

    expect(result.starting_balance).toBe(6000);
    expect(result.months).toEqual([
      {
        month: '2029-12',
        days: 11,
        scheduled_in: 0,
        scheduled_out: -50,
        // 2,500 and 300 times 11/31, to the cent.
        baseline_in: 887.1,
        baseline_out: -106.45,
        net: 730.65,
        ending_balance: 6730.65,
        accounts: [
          { account_id: 'checking', name: 'Checking', ending_balance: 1730.65 },
          { account_id: 'savings', name: 'Savings', ending_balance: 5000 },
        ],
      },
      {
        month: '2030-01',
        days: 31,
        scheduled_in: 0,
        // The transfer to Savings stays inside the accounts shown: it moves
        // balances but is not money out.
        scheduled_out: -1500,
        baseline_in: 2500,
        baseline_out: -300,
        net: 700,
        ending_balance: 7430.65,
        accounts: [
          { account_id: 'checking', name: 'Checking', ending_balance: 2230.65 },
          { account_id: 'savings', name: 'Savings', ending_balance: 5200 },
        ],
      },
      {
        month: '2030-02',
        days: 28,
        scheduled_in: 2500,
        scheduled_out: 0,
        baseline_in: 2500,
        baseline_out: -300,
        net: 4700,
        ending_balance: 12130.65,
        accounts: [
          { account_id: 'checking', name: 'Checking', ending_balance: 6930.65 },
          { account_id: 'savings', name: 'Savings', ending_balance: 5200 },
        ],
      },
    ]);
  });

  it('reports the lowest month-end overall and for each account', () => {
    const result = project({ events, baseline: averaged });

    expect(result.lowest_month_end).toEqual({
      month: '2029-12',
      balance: 6730.65,
    });
    expect(result.first_negative_month).toBeNull();
    expect(result.accounts).toEqual([
      {
        id: 'checking',
        name: 'Checking',
        starting_balance: 1000,
        ending_balance: 6930.65,
        lowest_month_end: { month: '2029-12', balance: 1730.65 },
        first_negative_month: null,
      },
      {
        id: 'savings',
        name: 'Savings',
        starting_balance: 5000,
        ending_balance: 5200,
        lowest_month_end: { month: '2029-12', balance: 5000 },
        first_negative_month: null,
      },
    ]);
  });

  it('describes the average it used', () => {
    const { baseline } = project({ events, baseline: averaged });

    expect(baseline).toEqual({
      months_averaged: 3,
      monthly_in: 2500,
      monthly_out: -300,
      top_spending: [{ category: 'Food', monthly_average: -300 }],
    });
  });

  it('projects scheduled items alone when asked to leave the average out', () => {
    const result = project({
      events,
      baseline: averaged,
      includeBaseline: false,
    });

    expect(result.months.map(month => month.baseline_in)).toEqual([0, 0, 0]);
    // 6,000 - 50 late fee; - 1,500 rent (the transfer between the two
    // accounts changes neither the total nor this); + 2,500 pay.
    expect(result.months.map(month => month.ending_balance)).toEqual([
      5950, 4450, 6950,
    ]);
    expect(result.baseline).toMatchObject({ monthly_in: 0, monthly_out: 0 });
  });

  it('finds the first month an account goes negative', () => {
    const result = project({
      accounts: [{ id: 'checking', name: 'Checking', balance: 10_000 }],
      events: [event({ date: '2030-01-05', amount: -50_000 })],
      includeBaseline: false,
    });

    expect(result.months.map(month => month.ending_balance)).toEqual([
      100, -400, -400,
    ]);
    expect(result.first_negative_month).toBe('2030-01');
    expect(result.lowest_month_end).toEqual({
      month: '2030-01',
      balance: -400,
    });
    expect(result.accounts[0].first_negative_month).toBe('2030-01');
  });

  it('moves money in from an account that is not shown, and out to one', () => {
    const result = project({
      accounts: [checking],
      events: [
        event({
          date: '2030-01-03',
          account_id: 'elsewhere',
          transfer_account_id: 'checking',
          amount: -30_000,
        }),
        event({
          date: '2030-01-04',
          transfer_account_id: 'elsewhere',
          amount: -10_000,
        }),
        event({ date: '2030-01-05', account_id: 'elsewhere', amount: -999 }),
      ],
      includeBaseline: false,
    });

    const january = result.months[1];
    expect(january.scheduled_in).toBe(300);
    expect(january.scheduled_out).toBe(-100);
    expect(january.ending_balance).toBe(1200);
  });

  it('covers no baseline days on the last day of the month', () => {
    const result = project({
      today: '2029-12-31',
      endMonth: '2030-01',
      accounts: [checking],
      baseline: averaged,
    });

    expect(result.months[0]).toMatchObject({
      month: '2029-12',
      days: 0,
      baseline_in: 0,
      baseline_out: 0,
      ending_balance: 1000,
    });
  });

  it('projects only the current month when it is also the last', () => {
    const result = project({ endMonth: '2029-12', events });
    expect(result.months).toHaveLength(1);
  });

  it('ignores averaged transactions from accounts that are not shown, and transfers', () => {
    const result = project({
      accounts: [checking],
      baseline: [
        ...averaged,
        earned('2029-10-05', 9000, 'Boss', 'Salary', {
          account_id: 'brokerage',
        }),
        spent('2029-10-06', 700, 'Move', null, { is_transfer: true }),
      ],
    });

    expect(result.baseline.monthly_in).toBe(2500);
    expect(result.baseline.monthly_out).toBe(-300);
  });
});
