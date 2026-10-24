import {
  earned,
  everyDays,
  monthly,
  repeat,
  spent,
  usd,
} from '#testing/transactions';

import { detectRecurring } from './recurring';
import type { AnalysisTransaction } from './transactions';

const TODAY = '2029-12-20';

function detect(
  transactions: AnalysisTransaction[],
  overrides: Partial<Parameters<typeof detectRecurring>[0]> = {},
) {
  return detectRecurring({
    transactions,
    today: TODAY,
    minOccurrences: 3,
    schedulesByPayee: new Map(),
    money: usd,
    ...overrides,
  });
}

const only = (transactions: AnalysisTransaction[]) => {
  const { charges } = detect(transactions);
  expect(charges).toHaveLength(1);
  return charges[0];
};

describe('cadences', () => {
  it('finds a weekly charge and prices it per month and year', () => {
    // Twelve Saturdays from 2029-09-29; the last is 2029-12-15.
    const charge = only(
      repeat(everyDays('2029-09-29', 7, 12), 12, 'Newsletter', 'Media'),
    );

    expect(charge).toMatchObject({
      payee: 'Newsletter',
      category: 'Media',
      direction: 'spending',
      cadence: 'weekly',
      typical_amount: -12,
      amount_variability: 'fixed',
      occurrences: 12,
      first_date: '2029-09-29',
      last_date: '2029-12-15',
      next_expected_date: '2029-12-22',
      days_since_last: 5,
      status: 'active',
      price_change: null,
      // 12.00 x 30.4375 / 7 days = 52.18 a month.
      estimated_monthly_amount: -52.18,
      estimated_yearly_amount: -626.14,
    });
  });

  it('finds fortnightly pay as income', () => {
    const pay = everyDays('2029-01-05', 14, 25).map(date =>
      earned(date, 2500, 'Employer'),
    );
    const report = detect(pay);

    expect(report.charges[0]).toMatchObject({
      direction: 'income',
      cadence: 'biweekly',
      typical_amount: 2500,
      last_date: '2029-12-07',
      next_expected_date: '2029-12-21',
      status: 'active',
    });
    expect(report.monthly_income).toBe(5435.27);
    expect(report.monthly_spending).toBe(0);
  });

  it('finds a monthly charge and expects the next one a month on', () => {
    const charge = only(
      repeat(monthly('2029-07', 12, 6), 15.99, 'Netflix', 'Bills'),
    );

    expect(charge).toMatchObject({
      cadence: 'monthly',
      last_date: '2029-12-12',
      next_expected_date: '2030-01-12',
      status: 'active',
      estimated_monthly_amount: -15.99,
      estimated_yearly_amount: -191.88,
    });
  });

  it('keeps to the day of the month, or the last day of a short one', () => {
    const charge = only(
      repeat(
        ['2029-08-31', '2029-09-30', '2029-10-31', '2029-11-30'],
        10,
        'Storage',
      ),
    );
    expect(charge.next_expected_date).toBe('2029-12-30');
  });

  it('finds a quarterly charge', () => {
    const charge = only(
      repeat(
        ['2029-01-10', '2029-04-11', '2029-07-11', '2029-10-10'],
        90,
        'Insurance',
      ),
    );
    expect(charge).toMatchObject({
      cadence: 'quarterly',
      next_expected_date: '2030-01-10',
      status: 'active',
    });
  });

  it('finds a yearly charge from two payments', () => {
    const charge = only(repeat(['2028-02-10', '2029-02-10'], 99, 'Domain'));
    expect(charge).toMatchObject({
      cadence: 'yearly',
      occurrences: 2,
      next_expected_date: '2030-02-10',
      status: 'active',
      estimated_yearly_amount: -99,
    });
  });

  it('does not call irregular charges recurring', () => {
    const dates = [
      '2029-01-03',
      '2029-01-19',
      '2029-03-30',
      '2029-04-02',
      '2029-08-14',
    ];
    expect(detect(repeat(dates, 25, 'Hobby Shop')).charges).toEqual([]);
  });

  it('does not call charges recurring when most gaps miss the cadence', () => {
    // Two of the three gaps are monthly, but only 67% - under the 75% needed.
    const dates = ['2029-01-05', '2029-02-05', '2029-03-06', '2029-06-20'];
    expect(detect(repeat(dates, 25, 'Odd Shop')).charges).toEqual([]);
  });
});

describe('amounts', () => {
  it('does not call charges recurring when the amount swings widely', () => {
    const charges = repeat(
      monthly('2029-07', 3, 6),
      [10, 50, 12, 90, 11, 60],
      'Groceries',
    );
    expect(detect(charges).charges).toEqual([]);
  });

  it('keeps bills that vary a little, and marks them variable', () => {
    const charge = only(
      repeat(
        monthly('2029-07', 3, 6),
        [80, 95, 70, 110, 85, 90],
        'Power Co',
        'Bills',
      ),
    );
    expect(charge.amount_variability).toBe('variable');
    expect(charge.typical_amount).toBe(-87.5);
  });

  it('treats several charges on one day as one', () => {
    const doubled = monthly('2029-07', 3, 6).flatMap(date => [
      spent(date, 5, 'Parking', 'Car'),
      spent(date, 5, 'Parking', 'Car'),
    ]);
    const charge = only(doubled);

    expect(charge.occurrences).toBe(6);
    expect(charge.typical_amount).toBe(-10);
  });
});

describe('what is not a recurring charge', () => {
  it('needs enough occurrences', () => {
    const three = repeat(monthly('2029-10', 12, 3), 15, 'Gym');
    const two = repeat(monthly('2029-11', 12, 2), 15, 'Gym');

    expect(detect(three).charges).toHaveLength(1);
    expect(detect(two).charges).toEqual([]);
    expect(detect(two, { minOccurrences: 2 }).charges).toHaveLength(1);
  });

  it('ignores transfers and charges with no payee', () => {
    const transfers = repeat(monthly('2029-07', 1, 6), 300, 'Move', null, {
      is_transfer: true,
    });
    const anonymous = repeat(monthly('2029-07', 2, 6), 20, 'Ignored').map(
      transaction => ({ ...transaction, payee_id: null, payee: null }),
    );
    expect(detect([...transfers, ...anonymous]).charges).toEqual([]);
  });
});

describe('stopped charges', () => {
  it('flags a charge that has not come for a cadence and a half', () => {
    const charge = only(repeat(monthly('2029-01', 5, 6), 9.99, 'Hulu'));

    expect(charge).toMatchObject({
      status: 'stopped',
      last_date: '2029-06-05',
      days_since_last: 198,
    });
  });

  it('draws the line at one and a half cadences', () => {
    // A month is 30.4 days, so the line is 45.7 days after the last charge.
    const lateButActive = only(repeat(monthly('2029-06', 10, 6), 20, 'Gym'));
    const stopped = only(repeat(monthly('2029-06', 1, 6), 20, 'Gym'));

    expect(lateButActive).toMatchObject({
      days_since_last: 40,
      status: 'active',
    });
    expect(stopped).toMatchObject({ days_since_last: 49, status: 'stopped' });
  });

  it('leaves stopped charges out of the monthly totals', () => {
    const report = detect([
      ...repeat(monthly('2029-07', 1, 6), 1500, 'Landlord'),
      ...repeat(monthly('2029-01', 5, 6), 9.99, 'Hulu'),
    ]);

    expect(report.monthly_spending).toBe(-1500);
  });
});

describe('price changes', () => {
  // Monthly charges on the 12th from January, one after another, `before`
  // and then `after`.
  const netflix = (before: number[], after: number[]) => {
    const amounts = [...before, ...after];
    return repeat(monthly('2029-01', 12, amounts.length), amounts, 'Netflix');
  };

  it('spots a move from one steady price to another and prices it at the new one', () => {
    const charge = only(
      netflix(
        [15.99, 15.99, 15.99, 15.99, 15.99, 15.99],
        [17.99, 17.99, 17.99, 17.99, 17.99, 17.99],
      ),
    );

    expect(charge.price_change).toEqual({
      from: -15.99,
      to: -17.99,
      percent_change: 12.5,
      changed_on: '2029-07-12',
    });
    expect(charge.typical_amount).toBe(-17.99);
    expect(charge.estimated_yearly_amount).toBe(-215.88);
  });

  it('spots a rise in the latest charge alone', () => {
    const charge = only(netflix([15.99, 15.99, 15.99, 15.99, 15.99], [17.99]));
    expect(charge.price_change).toMatchObject({
      from: -15.99,
      to: -17.99,
      changed_on: '2029-06-12',
    });
  });

  it('spots a price cut as a negative change', () => {
    const charge = only(netflix([20, 20, 20, 20], [16, 16, 16]));
    expect(charge.price_change).toMatchObject({
      from: -20,
      to: -16,
      percent_change: -20,
    });
  });

  it('needs the old price to have held for two charges', () => {
    const charge = only(netflix([15.99], [17.99, 17.99, 17.99]));
    expect(charge.price_change).toBeNull();
  });

  it('ignores a change under 5%', () => {
    const charge = only(
      netflix([15.99, 15.99, 15.99, 15.99], [16.5, 16.5, 16.5]),
    );
    expect(charge.price_change).toBeNull();
  });

  it('does not see a change in a bill that always moves', () => {
    const charge = only(
      repeat(monthly('2029-07', 3, 6), [80, 95, 70, 110, 85, 90], 'Power Co'),
    );
    expect(charge.price_change).toBeNull();
  });
});

describe('the report', () => {
  it('links a charge to the schedule that covers its payee', () => {
    const report = detect(repeat(monthly('2029-07', 12, 6), 15.99, 'Netflix'), {
      schedulesByPayee: new Map([
        ['netflix', { id: 's1', name: 'Netflix plan' }],
      ]),
    });
    expect(report.charges[0].schedule).toEqual({
      id: 's1',
      name: 'Netflix plan',
    });
  });

  it('lists active charges first, the costliest first', () => {
    const report = detect([
      ...repeat(monthly('2029-07', 12, 6), 15.99, 'Netflix'),
      ...repeat(monthly('2029-07', 1, 6), 1500, 'Landlord'),
      ...repeat(monthly('2029-01', 5, 6), 500, 'Old Club'),
    ]);

    expect(report.charges.map(({ payee, status }) => [payee, status])).toEqual([
      ['Landlord', 'active'],
      ['Netflix', 'active'],
      ['Old Club', 'stopped'],
    ]);
  });

  it('totals the active monthly cost, and keeps income apart', () => {
    const report = detect([
      ...repeat(monthly('2029-07', 12, 6), 15.99, 'Netflix'),
      ...repeat(monthly('2029-07', 1, 6), 1500, 'Landlord'),
      ...monthly('2029-07', 28, 6).map(date => earned(date, 4000, 'Employer')),
    ]);

    expect(report.monthly_spending).toBe(-1515.99);
    expect(report.monthly_income).toBe(4000);
  });
});
