import { extraCopiesTotal, findDuplicateGroups } from './duplicates';
import type { DuplicateCandidate } from './duplicates';

let nextId = 0;
function transaction(
  fields: Partial<DuplicateCandidate> & Pick<DuplicateCandidate, 'date'>,
): DuplicateCandidate {
  return {
    id: `t${++nextId}`,
    amount: -500,
    payee_id: 'costco',
    payee: 'Costco',
    imported_id: null,
    notes: null,
    ...fields,
  };
}

const windowDays = 3;

describe('findDuplicateGroups', () => {
  it('groups the same payee and amount within the window', () => {
    const first = transaction({ date: '2026-10-01' });
    const second = transaction({ date: '2026-10-03' });
    const groups = findDuplicateGroups([second, first], { windowDays });

    expect(groups).toEqual([
      { amount: -500, payee: 'Costco', transactions: [first, second] },
    ]);
  });

  it('ignores transactions further apart than the window', () => {
    const groups = findDuplicateGroups(
      [
        transaction({ date: '2026-10-01' }),
        transaction({ date: '2026-10-05' }),
      ],
      { windowDays },
    );

    expect(groups).toEqual([]);
  });

  it('keeps apart other amounts, other payees and transactions with no payee', () => {
    const groups = findDuplicateGroups(
      [
        transaction({ date: '2026-10-01' }),
        transaction({ date: '2026-10-01', amount: -501 }),
        transaction({ date: '2026-10-01', payee_id: 'netflix' }),
        transaction({ date: '2026-10-01', payee_id: null, payee: null }),
        transaction({ date: '2026-10-01', payee_id: null, payee: null }),
      ],
      { windowDays },
    );

    expect(groups).toEqual([]);
  });

  it('does not suspect two transactions the bank gave different ids', () => {
    const groups = findDuplicateGroups(
      [
        transaction({ date: '2026-10-01', imported_id: 'A1' }),
        transaction({ date: '2026-10-01', imported_id: 'A2' }),
      ],
      { windowDays },
    );

    expect(groups).toEqual([]);
  });

  it('suspects a manual entry beside an imported one, and an id seen twice', () => {
    const imported = transaction({ date: '2026-10-01', imported_id: 'A1' });
    const manual = transaction({ date: '2026-10-02' });
    const sameId = transaction({ date: '2026-10-20', imported_id: 'B1' });
    const sameIdAgain = transaction({ date: '2026-10-21', imported_id: 'B1' });

    const groups = findDuplicateGroups(
      [imported, manual, sameId, sameIdAgain],
      {
        windowDays,
      },
    );

    expect(groups.map(group => group.transactions)).toEqual([
      [imported, manual],
      [sameId, sameIdAgain],
    ]);
  });

  it('lists a manual entry together with both imported transactions it could copy', () => {
    const first = transaction({ date: '2026-10-01', imported_id: 'A1' });
    const manual = transaction({ date: '2026-10-02' });
    const second = transaction({ date: '2026-10-03', imported_id: 'A2' });

    const groups = findDuplicateGroups([first, manual, second], { windowDays });

    // The manual entry could be a copy of either, so all three are listed.
    expect(groups).toHaveLength(1);
    expect(groups[0].transactions).toEqual([first, manual, second]);
  });
});

describe('extraCopiesTotal', () => {
  it('adds up everything beyond the first of each group', () => {
    const groups = findDuplicateGroups(
      [
        transaction({ date: '2026-10-01' }),
        transaction({ date: '2026-10-02' }),
        transaction({ date: '2026-10-03' }),
        transaction({ date: '2026-10-01', payee_id: 'netflix', amount: -1599 }),
        transaction({ date: '2026-10-01', payee_id: 'netflix', amount: -1599 }),
      ],
      { windowDays },
    );

    expect(extraCopiesTotal(groups)).toBe(-500 * 2 + -1599);
    expect(extraCopiesTotal([])).toBe(0);
  });
});
