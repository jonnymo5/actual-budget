import {
  assessPair,
  CLEAR_MAX_DAYS,
  findExistingCounterparts,
  findTransferMatches,
} from './transfers';
import type { TransferCandidate } from './transfers';

function tx(
  id: string,
  date: string,
  dollars: number,
  account: string,
  extra: Partial<TransferCandidate> = {},
): TransferCandidate {
  return {
    id,
    date,
    amount: Math.round(dollars * 100),
    account_id: account.toLowerCase(),
    account,
    account_off_budget: false,
    payee: null,
    category_id: null,
    category: null,
    ...extra,
  };
}

describe('findTransferMatches', () => {
  it('pairs the two sides of one transfer and calls it clear', () => {
    const matches = findTransferMatches([
      tx('out', '2026-09-30', -500, 'Checking'),
      tx('in', '2026-10-01', 500, 'Visa'),
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      status: 'clear',
      from: { id: 'out' },
      to: { id: 'in' },
      alternatives: [],
      competing: [],
      days_apart: 1,
      reasons: [],
    });
  });

  it('pairs on the same day', () => {
    const [match] = findTransferMatches([
      tx('out', '2026-09-30', -12.34, 'Checking'),
      tx('in', '2026-09-30', 12.34, 'Visa'),
    ]);
    expect(match).toMatchObject({ status: 'clear', days_apart: 0 });
  });

  it('never pairs transactions in the same account', () => {
    expect(
      findTransferMatches([
        tx('out', '2026-09-30', -500, 'Checking'),
        tx('in', '2026-09-30', 500, 'Checking'),
      ]),
    ).toEqual([]);
  });

  it('needs the amounts to cancel exactly', () => {
    expect(
      findTransferMatches([
        tx('out', '2026-09-30', -500, 'Checking'),
        tx('in', '2026-09-30', 500.01, 'Visa'),
      ]),
    ).toEqual([]);
  });

  it('ignores transactions outside the window, and honours a wider one', () => {
    const pool = [
      tx('out', '2026-09-01', -500, 'Checking'),
      tx('in', '2026-09-08', 500, 'Visa'),
    ];
    expect(findTransferMatches(pool)).toEqual([]);
    expect(findTransferMatches(pool, { windowDays: 7 })).toHaveLength(1);
  });

  it('asks about sides further apart than the clear limit', () => {
    const [match] = findTransferMatches([
      tx('out', '2026-09-01', -500, 'Checking'),
      tx('in', '2026-09-05', 500, 'Visa'),
    ]);
    expect(match.days_apart).toBeGreaterThan(CLEAR_MAX_DAYS);
    expect(match).toMatchObject({
      status: 'needs_confirmation',
      to: { id: 'in' },
      reasons: ['dates_far_apart'],
    });
  });

  describe('when several transactions fit', () => {
    it('asks about two equal outflows that both fit one inflow', () => {
      const matches = findTransferMatches([
        tx('out1', '2026-09-29', -750, 'Checking'),
        tx('out2', '2026-09-30', -750, 'Checking'),
        tx('in', '2026-10-01', 750, 'Visa'),
      ]);

      expect(matches.map(m => m.status)).toEqual([
        'needs_confirmation',
        'needs_confirmation',
      ]);
      expect(matches[0].competing.map(c => c.id)).toEqual(['out2']);
      expect(matches[1].competing.map(c => c.id)).toEqual(['out1']);
      for (const match of matches) {
        expect(match.reasons).toContain('several_possible_matches');
      }
    });

    it('suggests the nearest inflow but still asks', () => {
      const [match] = findTransferMatches([
        tx('out', '2026-09-30', -300, 'Checking'),
        tx('far', '2026-10-03', 300, 'Visa'),
        tx('near', '2026-10-01', 300, 'Amex'),
      ]);

      expect(match).toMatchObject({
        status: 'needs_confirmation',
        to: { id: 'near' },
        reasons: ['several_possible_matches'],
      });
      // Nearest first.
      expect(match.alternatives.map(a => a.id)).toEqual(['near', 'far']);
    });

    it('offers no suggestion when two are equally near', () => {
      const [match] = findTransferMatches([
        tx('out', '2026-09-30', -300, 'Checking'),
        tx('a', '2026-10-01', 300, 'Visa'),
        tx('b', '2026-09-29', 300, 'Amex'),
      ]);

      expect(match.to).toBeNull();
      expect(match.days_apart).toBeNull();
      expect(match.status).toBe('needs_confirmation');
      expect(match.reasons).toEqual(['several_possible_matches']);
      expect(match.alternatives.map(a => a.id).sort()).toEqual(['a', 'b']);
    });

    it('does not mind equal amounts that are too far apart to compete', () => {
      const matches = findTransferMatches([
        tx('out1', '2026-09-01', -750, 'Checking'),
        tx('in1', '2026-09-02', 750, 'Visa'),
        tx('out2', '2026-09-20', -750, 'Checking'),
        tx('in2', '2026-09-21', 750, 'Visa'),
      ]);
      expect(matches.map(m => [m.from.id, m.to?.id, m.status])).toEqual([
        ['out1', 'in1', 'clear'],
        ['out2', 'in2', 'clear'],
      ]);
    });
  });

  describe('categories', () => {
    const groceries = { category_id: 'groceries', category: 'Groceries' };

    it('asks when linking would drop a category between two on-budget accounts', () => {
      const [match] = findTransferMatches([
        tx('out', '2026-09-30', -500, 'Checking', groceries),
        tx('in', '2026-09-30', 500, 'Savings'),
      ]);
      expect(match).toMatchObject({
        status: 'needs_confirmation',
        reasons: ['category_would_be_cleared'],
      });
    });

    it('asks when the category is on the inflow instead', () => {
      const [match] = findTransferMatches([
        tx('out', '2026-09-30', -500, 'Checking'),
        tx('in', '2026-09-30', 500, 'Savings', groceries),
      ]);
      expect(match.reasons).toEqual(['category_would_be_cleared']);
    });

    it('keeps the category, so does not ask, between an on-budget and an off-budget account', () => {
      const [match] = findTransferMatches([
        tx('out', '2026-09-30', -500, 'Checking', groceries),
        tx('in', '2026-09-30', 500, 'Brokerage', { account_off_budget: true }),
      ]);
      expect(match).toMatchObject({ status: 'clear', reasons: [] });
    });

    it('asks between two off-budget accounts too', () => {
      const [match] = findTransferMatches([
        tx('out', '2026-09-30', -500, 'IRA', {
          account_off_budget: true,
          ...groceries,
        }),
        tx('in', '2026-09-30', 500, 'Brokerage', { account_off_budget: true }),
      ]);
      expect(match.reasons).toEqual(['category_would_be_cleared']);
    });
  });

  it('lists matches oldest first', () => {
    const matches = findTransferMatches([
      tx('out-late', '2026-10-20', -10, 'Checking'),
      tx('in-late', '2026-10-20', 10, 'Visa'),
      tx('out-early', '2026-09-02', -20, 'Checking'),
      tx('in-early', '2026-09-02', 20, 'Visa'),
    ]);
    expect(matches.map(m => m.from.id)).toEqual(['out-early', 'out-late']);
  });

  it('skips zero amounts', () => {
    expect(
      findTransferMatches([
        tx('a', '2026-09-30', 0, 'Checking'),
        tx('b', '2026-09-30', 0, 'Visa'),
      ]),
    ).toEqual([]);
  });
});

describe('assessPair', () => {
  it('finds nothing wrong with a lone pair', () => {
    const out = tx('out', '2026-09-30', -500, 'Checking');
    const inn = tx('in', '2026-10-01', 500, 'Visa');
    expect(assessPair([out, inn], out, inn)).toEqual([]);
  });

  it('flags a pair chosen from several, and one with distant dates', () => {
    const out = tx('out', '2026-09-30', -500, 'Checking');
    const inn = tx('in', '2026-10-05', 500, 'Visa');
    const other = tx('other', '2026-10-01', 500, 'Amex');

    expect(assessPair([out, inn, other], out, inn, { windowDays: 7 })).toEqual([
      'several_possible_matches',
      'dates_far_apart',
    ]);
  });

  it('flags a dropped category', () => {
    const out = tx('out', '2026-09-30', -500, 'Checking', {
      category_id: 'x',
      category: 'X',
    });
    const inn = tx('in', '2026-09-30', 500, 'Savings');
    expect(assessPair([out, inn], out, inn)).toEqual([
      'category_would_be_cleared',
    ]);
  });
});

describe('findExistingCounterparts', () => {
  const out = tx('out', '2026-09-30', -500, 'Checking');

  it('finds an opposite amount in the target account within the window', () => {
    const there = tx('there', '2026-10-02', 500, 'Savings');
    const elsewhere = tx('elsewhere', '2026-10-02', 500, 'Visa');
    expect(
      findExistingCounterparts([out, there, elsewhere], out, 'savings').map(
        t => t.id,
      ),
    ).toEqual(['there']);
  });

  it('ignores amounts that differ and dates outside the window', () => {
    const wrongAmount = tx('wrong', '2026-10-01', 400, 'Savings');
    const tooLate = tx('late', '2026-10-30', 500, 'Savings');
    expect(
      findExistingCounterparts([out, wrongAmount, tooLate], out, 'savings'),
    ).toEqual([]);
  });
});
