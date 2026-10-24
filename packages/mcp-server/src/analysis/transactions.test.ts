import { earned, refunded, spent } from '#testing/transactions';

import { classifyFlow, groupOf, UNCATEGORIZED } from './transactions';

describe('classifyFlow', () => {
  it('trusts the category when there is one', () => {
    expect(classifyFlow(spent('2029-05-01', 20, 'Shop', 'Food'))).toBe(
      'spending',
    );
    expect(classifyFlow(earned('2029-05-01', 900, 'Boss'))).toBe('income');
  });

  it('counts a refund in a spending category as reducing spending', () => {
    expect(classifyFlow(refunded('2029-05-02', 20, 'Shop', 'Food'))).toBe(
      'spending',
    );
  });

  it('falls back to the sign without a category', () => {
    expect(classifyFlow(spent('2029-05-01', 9.99, 'Mystery'))).toBe('spending');
    expect(
      classifyFlow({ ...earned('2029-05-01', 5, 'Gift'), category_id: null }),
    ).toBe('income');
  });

  it('ignores transfers unless they carry a category', () => {
    const uncategorized = spent('2029-05-01', 300, 'Transfer', null, {
      is_transfer: true,
    });
    expect(classifyFlow(uncategorized)).toBeNull();

    const budgeted = spent('2029-05-01', 300, 'Transfer', 'Savings', {
      is_transfer: true,
    });
    expect(classifyFlow(budgeted)).toBe('spending');
  });

  it('ignores zero amounts', () => {
    expect(classifyFlow(spent('2029-05-01', 0, 'Shop', 'Food'))).toBeNull();
  });
});

describe('groupOf', () => {
  const purchase = spent('2029-05-17', 12, 'Corner Cafe', 'Dining');

  it('names the group a transaction belongs to', () => {
    expect(groupOf(purchase, 'category')).toEqual({
      key: 'dining',
      name: 'Dining',
    });
    expect(groupOf(purchase, 'category_group')).toEqual({
      key: 'Everyday',
      name: 'Everyday',
    });
    expect(groupOf(purchase, 'payee')).toEqual({
      key: 'corner-cafe',
      name: 'Corner Cafe',
    });
    expect(groupOf(purchase, 'month')).toEqual({
      key: '2029-05',
      name: '2029-05',
    });
  });

  it('labels what is missing instead of dropping it', () => {
    const bare = spent('2029-05-17', 12, null);
    expect(groupOf(bare, 'category').name).toBe(UNCATEGORIZED);
    expect(groupOf(bare, 'category_group').name).toBe(UNCATEGORIZED);
    expect(groupOf(bare, 'payee').name).toBe('(no payee)');
  });
});
