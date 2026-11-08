import { describe, expect, it } from 'vitest';

import type {
  RsuGrantEntity,
  RsuVestEventEntity,
  StockPriceEntity,
} from '#types/models';

import {
  estimateVestNet,
  generateVestEvents,
  planDepositMatches,
  planIncomeBudget,
  projectRsuIncomeByMonth,
  rsuScheduleName,
  summarizeGrantPayout,
  sumShares,
  vestEventNet,
  vestEventValue,
} from './rsu';

describe('generateVestEvents', () => {
  it('spreads shares evenly over quarterly periods and sums exactly', () => {
    const rows = generateVestEvents({
      totalShares: 100,
      vestStart: '2024-01-15',
      frequency: 'quarterly',
      periods: 16,
    });

    expect(rows).toHaveLength(16);
    expect(rows[0]).toEqual({ vest_date: '2024-01-15', shares: 6.25 });
    expect(rows[1].vest_date).toBe('2024-04-15');
    expect(rows[15].vest_date).toBe('2027-10-15');
    expect(sumShares(rows)).toBe(100);
  });

  it('puts the rounding remainder on the last row', () => {
    const rows = generateVestEvents({
      totalShares: 100,
      vestStart: '2024-01-01',
      frequency: 'monthly',
      periods: 3,
    });

    expect(rows.map(row => row.shares)).toEqual([
      33.333333, 33.333333, 33.333334,
    ]);
    expect(sumShares(rows)).toBe(100);
  });

  it('adds a cliff row followed by the regular periods', () => {
    const rows = generateVestEvents({
      totalShares: 400,
      vestStart: '2024-01-15',
      frequency: 'quarterly',
      periods: 12,
      cliffPercent: 25,
      cliffMonths: 12,
    });

    expect(rows).toHaveLength(13);
    expect(rows[0]).toEqual({ vest_date: '2025-01-15', shares: 100 });
    expect(rows[1]).toEqual({ vest_date: '2025-04-15', shares: 25 });
    expect(rows[12].vest_date).toBe('2028-01-15');
    expect(sumShares(rows)).toBe(400);
  });

  it('anchors month-end dates to the start date without drifting', () => {
    const rows = generateVestEvents({
      totalShares: 3,
      vestStart: '2024-01-31',
      frequency: 'monthly',
      periods: 3,
    });

    expect(rows.map(row => row.vest_date)).toEqual([
      '2024-01-31',
      '2024-02-29',
      '2024-03-31',
    ]);
  });

  it('handles fractional totals and a single period', () => {
    expect(
      generateVestEvents({
        totalShares: 12.5,
        vestStart: '2025-06-01',
        frequency: 'annual',
        periods: 1,
      }),
    ).toEqual([{ vest_date: '2025-06-01', shares: 12.5 }]);
  });

  it('returns nothing for zero shares or zero rows', () => {
    expect(
      generateVestEvents({
        totalShares: 0,
        vestStart: '2025-06-01',
        frequency: 'annual',
        periods: 4,
      }),
    ).toEqual([]);
    expect(
      generateVestEvents({
        totalShares: 10,
        vestStart: '2025-06-01',
        frequency: 'annual',
        periods: 0,
      }),
    ).toEqual([]);
  });
});

describe('estimateVestNet', () => {
  it('rounds gross and net to cents and clamps the rate', () => {
    expect(
      estimateVestNet({
        shares: 6.25,
        priceCents: 12345,
        withholdingRate: 0.37,
      }),
    ).toEqual({ gross: 77156, net: 48608 });
    expect(
      estimateVestNet({ shares: 10, priceCents: 1000, withholdingRate: 1.5 }),
    ).toEqual({ gross: 10000, net: 0 });
    expect(
      estimateVestNet({ shares: 10, priceCents: 1000, withholdingRate: -1 }),
    ).toEqual({ gross: 10000, net: 10000 });
  });
});

describe('projectRsuIncomeByMonth', () => {
  const grant: RsuGrantEntity = {
    id: 'g1',
    name: 'Grant one',
    ticker: 'ABCD',
    grant_date: '2024-01-01',
    total_shares: 100,
    account: 'acct',
    category: null,
    payee: 'payee',
    withholding_rate: 0.5,
    notes: null,
    sort_order: null,
  };
  const price: StockPriceEntity = {
    id: 'ABCD',
    price: 10000,
    currency: 'USD',
    as_of: null,
    updated_at: null,
    source: 'manual',
    manual_override: true,
  };
  function event(
    id: string,
    vest_date: string,
    shares: number,
    actual_net: number | null = null,
  ): RsuVestEventEntity {
    return {
      id,
      grant_id: 'g1',
      vest_date,
      shares,
      schedule: null,
      actual_price: null,
      actual_net,
      notes: null,
    };
  }

  it('buckets estimated and recorded nets by month of the requested year', () => {
    const projection = projectRsuIncomeByMonth({
      grants: [grant],
      events: [
        event('e1', '2025-01-15', 10, 40000),
        event('e2', '2025-04-15', 10),
        event('e3', '2025-04-20', 2),
        event('e4', '2026-01-15', 10),
      ],
      prices: [price],
      year: 2025,
    });

    expect(projection.rows[0].months[0]).toBe(40000);
    expect(projection.rows[0].months[3]).toBe(60000);
    expect(projection.rows[0].total).toBe(100000);
    expect(projection.rows[0].recordedMonths).toEqual([0]);
    expect(projection.totals[3]).toBe(60000);
    expect(projection.grandTotal).toBe(100000);
    expect(projection.missingPriceTickers).toEqual([]);
  });

  it('reports tickers without a price and skips their estimates', () => {
    const projection = projectRsuIncomeByMonth({
      grants: [grant],
      events: [
        event('e1', '2025-01-15', 10),
        event('e2', '2025-02-15', 10, 123),
      ],
      prices: [],
      year: 2025,
    });

    expect(projection.rows[0].months[0]).toBe(0);
    expect(projection.rows[0].months[1]).toBe(123);
    expect(projection.missingPriceTickers).toEqual(['ABCD']);
  });

  it('prefers the recorded actual over the estimate', () => {
    expect(vestEventNet(event('e', '2025-01-01', 10, 777), grant, price)).toBe(
      777,
    );
    expect(vestEventNet(event('e', '2025-01-01', 10), grant, price)).toBe(
      50000,
    );
    expect(vestEventNet(event('e', '2025-01-01', 10), grant, null)).toBeNull();
  });
});

describe('rsuScheduleName', () => {
  it('builds a stable name and suffixes duplicates', () => {
    expect(rsuScheduleName(' Grant one ', '2025-01-15')).toBe(
      'RSU · Grant one · 2025-01-15',
    );
    expect(rsuScheduleName('Grant one', '2025-01-15', 1)).toBe(
      'RSU · Grant one · 2025-01-15 (2)',
    );
  });
});

describe('vestEventValue', () => {
  const grant = { withholding_rate: 0.4 };
  const current = { price: 20000 };

  it('prefers the recorded net, then the locked price, then the quote', () => {
    expect(
      vestEventValue(
        { shares: 10, actual_net: 55000, actual_price: 10000 },
        grant,
        current,
      ),
    ).toEqual({ gross: 100000, net: 55000, basis: 'actual' });
    expect(
      vestEventValue(
        { shares: 10, actual_net: null, actual_price: 10000 },
        grant,
        current,
      ),
    ).toEqual({ gross: 100000, net: 60000, basis: 'locked' });
    expect(
      vestEventValue(
        { shares: 10, actual_net: null, actual_price: null },
        grant,
        current,
      ),
    ).toEqual({ gross: 200000, net: 120000, basis: 'current' });
    expect(
      vestEventValue(
        { shares: 10, actual_net: null, actual_price: null },
        grant,
        null,
      ),
    ).toBeNull();
  });

  it('summarises what a grant has paid and still owes', () => {
    const summary = summarizeGrantPayout(
      grant,
      [
        {
          vest_date: '2024-01-15',
          shares: 10,
          actual_net: 55000,
          actual_price: 10000,
        },
        {
          vest_date: '2024-04-15',
          shares: 10,
          actual_net: null,
          actual_price: 12000,
        },
        {
          vest_date: '2024-07-15',
          shares: 10,
          actual_net: null,
          actual_price: null,
        },
        {
          vest_date: '2026-01-15',
          shares: 10,
          actual_net: null,
          actual_price: null,
        },
      ],
      null,
      '2025-01-01',
    );
    expect(summary).toEqual({
      paidOut: 55000 + 72000,
      remaining: 0,
      unvaluedCount: 2,
      vestedShares: 30,
      unvestedShares: 10,
    });
    expect(
      summarizeGrantPayout(
        grant,
        [
          {
            vest_date: '2026-01-15',
            shares: 10,
            actual_net: null,
            actual_price: null,
          },
        ],
        current,
        '2025-01-01',
      ).remaining,
    ).toBe(120000);
  });
});

describe('planDepositMatches', () => {
  it('gives each vest the closest unused deposit inside the window', () => {
    const plan = planDepositMatches(
      [
        { id: 'nov', vest_date: '2024-11-15' },
        { id: 'oct', vest_date: '2024-10-15' },
        { id: 'dec', vest_date: '2024-12-15' },
      ],
      [
        { id: 't-early', date: '2024-10-01', amount: 1000 },
        { id: 't-oct', date: '2024-10-18', amount: 61000 },
        { id: 't-nov', date: '2024-11-20', amount: 59000 },
        { id: 't-neg', date: '2024-12-16', amount: -5 },
      ],
    );

    expect(plan.matched.map(m => [m.eventId, m.transactionId])).toEqual([
      ['oct', 't-oct'],
      ['nov', 't-nov'],
    ]);
    expect(plan.unmatched).toEqual(['dec']);
  });
});

describe('planIncomeBudget', () => {
  const grant = (
    id: string,
    overrides: Partial<RsuGrantEntity> = {},
  ): Pick<
    RsuGrantEntity,
    'id' | 'ticker' | 'category' | 'withholding_rate'
  > => ({
    id,
    ticker: 'ABCD',
    category: 'cat-stock',
    withholding_rate: 0.5,
    ...overrides,
  });
  const vest = (
    grant_id: string,
    vest_date: string,
    shares: number,
    overrides: Partial<RsuVestEventEntity> = {},
  ) => ({
    grant_id,
    vest_date,
    shares,
    actual_net: null,
    actual_price: null,
    ...overrides,
  });
  const prices = [{ id: 'ABCD', price: 10000 }];

  it('sums every grant vesting in the same month and budgets 0 otherwise', () => {
    const plan = planIncomeBudget({
      grants: [grant('a'), grant('b')],
      events: [
        vest('a', '2025-03-08', 10),
        vest('b', '2025-03-22', 4),
        vest('b', '2025-04-22', 2),
      ],
      prices,
      months: ['2025-02', '2025-03', '2025-04'],
    });
    // 10 and 4 shares × $100 × (1 − 50%) in March, 2 shares in April
    expect(plan.amounts).toEqual([
      { category: 'cat-stock', month: '2025-02', amount: 0 },
      { category: 'cat-stock', month: '2025-03', amount: 70000 },
      { category: 'cat-stock', month: '2025-04', amount: 10000 },
    ]);
    expect(plan.unpriced).toEqual([]);
  });

  it('keeps categories apart and skips grants without one', () => {
    const plan = planIncomeBudget({
      grants: [
        grant('a'),
        grant('b', { category: 'cat-other' }),
        grant('c', { category: null }),
      ],
      events: [
        vest('a', '2025-03-22', 2),
        vest('b', '2025-03-22', 4),
        vest('c', '2025-03-22', 8),
      ],
      prices,
      months: ['2025-03'],
    });
    expect(plan.amounts).toEqual([
      { category: 'cat-stock', month: '2025-03', amount: 10000 },
      { category: 'cat-other', month: '2025-03', amount: 20000 },
    ]);
  });

  it('uses a recorded net or locked price before the current quote', () => {
    const plan = planIncomeBudget({
      grants: [grant('a')],
      events: [
        vest('a', '2025-03-01', 10, { actual_net: 12345 }),
        vest('a', '2025-03-15', 10, { actual_price: 5000 }),
        vest('a', '2025-03-29', 10),
      ],
      prices,
      months: ['2025-03'],
    });
    expect(plan.amounts).toEqual([
      {
        category: 'cat-stock',
        month: '2025-03',
        amount: 12345 + 25000 + 50000,
      },
    ]);
  });

  it('leaves out months with a vest that has no price', () => {
    const plan = planIncomeBudget({
      grants: [grant('a', { ticker: 'zzzz' })],
      events: [vest('a', '2025-03-22', 10)],
      prices,
      months: ['2025-02', '2025-03'],
    });
    expect(plan.amounts).toEqual([
      { category: 'cat-stock', month: '2025-02', amount: 0 },
    ]);
    expect(plan.unpriced).toEqual([
      { category: 'cat-stock', month: '2025-03', ticker: 'ZZZZ' },
    ]);
  });

  it('adds scheduled income to the same category and month', () => {
    const plan = planIncomeBudget({
      grants: [grant('a')],
      events: [vest('a', '2025-03-22', 2)],
      prices,
      scheduled: [
        { category: 'cat-stock', date: '2025-03-15', amount: 5000 },
        { category: 'cat-bonus', date: '2025-04-15', amount: 300000 },
        { category: 'cat-bonus', date: '2026-04-15', amount: 300000 },
      ],
      months: ['2025-03', '2025-04'],
    });
    expect(plan.amounts).toEqual([
      { category: 'cat-stock', month: '2025-03', amount: 10000 + 5000 },
      { category: 'cat-stock', month: '2025-04', amount: 0 },
      { category: 'cat-bonus', month: '2025-03', amount: 0 },
      { category: 'cat-bonus', month: '2025-04', amount: 300000 },
    ]);
  });

  it('ignores vests outside the months asked for', () => {
    const plan = planIncomeBudget({
      grants: [grant('a')],
      events: [vest('a', '2024-12-22', 10), vest('a', '2026-01-22', 10)],
      prices,
      months: ['2025-01'],
    });
    expect(plan.amounts).toEqual([
      { category: 'cat-stock', month: '2025-01', amount: 0 },
    ]);
  });
});
