import {
  earned,
  everyDays,
  monthly,
  repeat,
  spent,
  usd,
} from '#testing/transactions';

import { findOutliers } from './outliers';
import type { Sensitivity } from './outliers';
import type { AnalysisTransaction } from './transactions';

const window = { start: '2029-12-01', end: '2029-12-31' };

function screen(
  transactions: AnalysisTransaction[],
  overrides: Partial<Parameters<typeof findOutliers>[0]> = {},
) {
  return findOutliers({
    transactions,
    window,
    historyMonths: 12,
    sensitivity: 'medium',
    minAmount: 2000,
    duplicateWindowDays: 3,
    dataStartDate: '2019-02-06',
    money: usd,
    ...overrides,
  });
}

// Eight hardware purchases of about 40, March to October. Sorted they are
// 38 39 40 40 41 42 42 43: median 40.50, quartiles 39.75 and 42, so the
// "usual" upper limit is 42 + 2 x 2.25 = 46.50.
const hardware = repeat(
  monthly('2029-03', 5, 8),
  [38, 42, 40, 41, 39, 43, 40, 42],
  'Hardware',
  'General',
);

describe('unusual amounts', () => {
  it('flags a purchase far above what the payee usually costs', () => {
    const report = screen([
      ...hardware,
      spent('2029-12-10', 400, 'Hardware', 'General'),
    ]);

    expect(report.checked_count).toBe(1);
    expect(report.outliers).toHaveLength(1);
    const [finding] = report.outliers;
    expect(finding).toMatchObject({
      type: 'unusual_amount',
      baseline: 'payee',
      baseline_size: 8,
      typical_amount: -40.5,
      times_typical: 9.9,
      related_transaction: null,
      transaction: { date: '2029-12-10', amount: -400, payee: 'Hardware' },
    });
    expect(finding.z_score).toBeGreaterThan(100);
    expect(finding.reason).toBe(
      'Hardware 400.00 is 9.9x the usual 40.50 for this payee (8 earlier purchases)',
    );
  });

  it('leaves normal purchases alone, even slightly high ones', () => {
    // 47 is above the 46.50 limit but only 1.2x the usual, so not worth a look.
    for (const dollars of [41, 45, 47]) {
      const report = screen([
        ...hardware,
        spent('2029-12-10', dollars, 'Hardware', 'General'),
      ]);
      expect(report.outliers, `${dollars}`).toEqual([]);
    }
  });

  it('falls back to the category when the payee has little history', () => {
    const shops = ['Shop A', 'Shop B', 'Shop C'];
    const history = monthly('2029-03', 7, 9).map((date, index) =>
      spent(date, 38 + (index % 5), shops[index % 3], 'General'),
    );
    const report = screen([
      ...history,
      spent('2029-12-10', 400, 'Somewhere New', 'General'),
    ]);

    expect(report.outliers).toHaveLength(1);
    expect(report.outliers[0]).toMatchObject({
      type: 'unusual_amount',
      baseline: 'category',
      baseline_size: 9,
    });
  });

  it('says nothing when there is too little history to judge by', () => {
    const report = screen([
      ...hardware.slice(0, 4),
      spent('2029-12-10', 400, 'Hardware', 'General'),
    ]);
    expect(report.outliers).toEqual([]);
  });

  it('only looks at the window, and only at purchases', () => {
    const report = screen([
      ...hardware,
      spent('2029-11-20', 400, 'Hardware', 'General'),
      spent('2030-01-02', 400, 'Hardware', 'General'),
      earned('2029-12-05', 9000, 'Boss'),
    ]);
    expect(report.outliers).toEqual([]);
    expect(report.checked_count).toBe(0);
  });

  it('ignores anything below the minimum amount', () => {
    const report = screen(
      [...hardware, spent('2029-12-10', 400, 'Hardware', 'General')],
      { minAmount: 50_000 },
    );
    expect(report.outliers).toEqual([]);
  });

  describe('sensitivity', () => {
    // 20 40 ... 160: median 90, quartiles 55 and 125, so the limits are
    // 335 (low), 265 (medium) and 230 (high).
    const history = repeat(
      monthly('2029-03', 5, 8),
      [20, 40, 60, 80, 100, 120, 140, 160],
      'Gym Shop',
      'General',
    );
    const flagged = (dollars: number, sensitivity: Sensitivity) =>
      screen(
        [...history, spent('2029-12-10', dollars, 'Gym Shop', 'General')],
        {
          sensitivity,
        },
      ).outliers.length === 1;

    it.each([
      [250, { low: false, medium: false, high: true }],
      [300, { low: false, medium: true, high: true }],
      [400, { low: true, medium: true, high: true }],
    ])('flags %s at the sensitivities it should', (dollars, expected) => {
      for (const level of ['low', 'medium', 'high'] as const) {
        expect(flagged(dollars, level), `${dollars} at ${level}`).toBe(
          expected[level],
        );
      }
    });
  });
});

describe('new payees', () => {
  // 25 purchases of 4, 8, ... 100 from one shop. The 90th percentile of the
  // sizes is 90.40.
  const history = everyDays('2029-03-01', 10, 25).map((date, index) =>
    spent(date, 4 * (index + 1), 'Shop', 'General'),
  );

  it('flags a first purchase that is among the largest in the budget', () => {
    const report = screen([
      ...history,
      spent('2029-12-12', 500, 'Fancy Place', 'General'),
    ]);

    const finding = report.outliers.find(({ type }) => type === 'new_payee');
    expect(finding?.transaction.payee).toBe('Fancy Place');
    expect(finding?.reason).toBe(
      'first purchase ever from Fancy Place, and at 500.00 it is as large as the biggest 10% of past purchases (90.40 or more)',
    );
  });

  it('draws the line at the 90th percentile', () => {
    const at = (dollars: number) =>
      screen([
        ...history,
        spent('2029-12-12', dollars, 'New Place', 'Misc'),
      ]).outliers.filter(({ type }) => type === 'new_payee').length;

    expect(at(90)).toBe(0);
    expect(at(91)).toBe(1);
  });

  it('does not call a payee new when it has been seen before', () => {
    const report = screen([
      ...history,
      spent('2029-12-12', 500, 'Shop', 'General'),
    ]);
    expect(report.outliers.map(({ type }) => type)).not.toContain('new_payee');
  });

  it('reports a new payee once, not again as an unusual amount for its category', () => {
    const report = screen([
      ...history,
      spent('2029-12-12', 500, 'Fancy Place', 'General'),
    ]);
    expect(report.outliers.map(({ type }) => type)).toEqual(['new_payee']);
  });

  it('says it skipped the check when the budget is too young to know', () => {
    const report = screen(
      [...history, spent('2029-12-12', 500, 'Fancy Place', 'General')],
      { dataStartDate: '2029-11-15' },
    );

    expect(report.outliers.map(({ type }) => type)).not.toContain('new_payee');
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toMatch(/Skipped the new-payee check/);
  });

  it('says it skipped the check when there are too few past purchases', () => {
    const report = screen([
      ...history.slice(0, 5),
      spent('2029-12-12', 500, 'Fancy Place', 'General'),
    ]);
    expect(report.notes[0]).toMatch(/Skipped the new-payee check/);
  });
});

describe('possible duplicates', () => {
  const twice = (second: string, extra: Partial<AnalysisTransaction> = {}) => [
    spent('2029-12-03', 63.17, 'Amazon', 'General'),
    spent(second, 63.17, 'Amazon', 'General', extra),
  ];

  it('flags the same charge again the next day, pointing at the first', () => {
    const [first, second] = twice('2029-12-04');
    const report = screen([first, second]);

    expect(report.outliers).toHaveLength(1);
    expect(report.outliers[0]).toMatchObject({
      type: 'possible_duplicate',
      days_apart: 1,
      transaction: { id: second.id, date: '2029-12-04' },
      related_transaction: { id: first.id, date: '2029-12-03' },
      reason:
        'Amazon 63.17 appears again 1 day after 2029-12-03 in the same account',
    });
  });

  it('flags a same-day repeat, and respects the day window', () => {
    expect(screen(twice('2029-12-03')).outliers[0].reason).toMatch(
      /on the same day/,
    );
    expect(screen(twice('2029-12-06')).outliers).toHaveLength(1);
    expect(screen(twice('2029-12-07')).outliers).toEqual([]);
    expect(
      screen(twice('2029-12-04'), { duplicateWindowDays: 0 }).outliers,
    ).toEqual([]);
  });

  it.each([
    ['another account', { account_id: 'savings' }],
    ['another payee', { payee_id: 'ebay', payee: 'eBay' }],
    ['another amount', { amount: -6318 }],
  ])('does not flag a charge from %s', (_, difference) => {
    expect(screen(twice('2029-12-04', difference)).outliers).toEqual([]);
  });

  it('does not flag small repeats, transfers or charges with no payee', () => {
    const coffee = [
      spent('2029-12-03', 5, 'Cafe', 'Dining'),
      spent('2029-12-03', 5, 'Cafe', 'Dining'),
    ];
    expect(screen(coffee).outliers).toEqual([]);

    const moves = [
      spent('2029-12-03', 300, 'Move', null, { is_transfer: true }),
      spent('2029-12-04', 300, 'Move', null, { is_transfer: true }),
    ];
    expect(screen(moves).outliers).toEqual([]);

    const anonymous = [
      spent('2029-12-03', 63.17, null, 'General'),
      spent('2029-12-04', 63.17, null, 'General'),
    ];
    expect(screen(anonymous).outliers).toEqual([]);
  });

  it('flags a double deposit', () => {
    const report = screen([
      earned('2029-12-05', 2500, 'Employer'),
      earned('2029-12-05', 2500, 'Employer'),
    ]);
    expect(report.outliers).toHaveLength(1);
    expect(report.outliers[0].type).toBe('possible_duplicate');
  });

  it('reports a pair only when the second charge is inside the window', () => {
    const before = [
      spent('2029-11-03', 63.17, 'Amazon', 'General'),
      spent('2029-11-04', 63.17, 'Amazon', 'General'),
    ];
    expect(screen(before).outliers).toEqual([]);

    const across = [
      spent('2029-11-30', 63.17, 'Amazon', 'General'),
      spent('2029-12-01', 63.17, 'Amazon', 'General'),
    ];
    expect(screen(across).outliers).toHaveLength(1);
  });

  it('reports each repeat in a run of three', () => {
    const run = ['2029-12-03', '2029-12-04', '2029-12-05'].map(date =>
      spent(date, 63.17, 'Amazon', 'General'),
    );
    expect(screen(run).outliers).toHaveLength(2);
  });
});

describe('the report', () => {
  it('lists the largest amount first', () => {
    const report = screen([
      ...hardware,
      spent('2029-12-03', 63.17, 'Amazon', 'Shopping'),
      spent('2029-12-04', 63.17, 'Amazon', 'Shopping'),
      spent('2029-12-10', 400, 'Hardware', 'General'),
    ]);

    expect(
      report.outliers.map(({ transaction }) => transaction.amount),
    ).toEqual([-400, -63.17]);
  });

  it('says where the yardstick starts', () => {
    expect(screen([]).history_start).toBe('2028-12-01');
    expect(screen([], { historyMonths: 3 }).history_start).toBe('2029-09-01');
  });
});
