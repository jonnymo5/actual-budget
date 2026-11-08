import { describe, expect, it } from 'vitest';

import type {
  RsuGrantEntity,
  RsuVestEventEntity,
  StockPriceEntity,
} from '#types/models';

import {
  estimateVestNet,
  generateVestEvents,
  projectRsuIncomeByMonth,
  rsuScheduleName,
  sumShares,
  vestEventNet,
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
