import { drawn, earned, refunded, spent } from '#testing/transactions';

import {
  classifyFlow,
  groupOf,
  isSavingsDraw,
  UNCATEGORIZED,
} from './transactions';

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

  describe('money drawn from a tracking account', () => {
    it('is not income, even when filed under an income category to fund the envelopes', () => {
      const sale = drawn('2029-05-01', 5000, 'Brokerage', 'Starting Balances');
      expect(sale.category_is_income).toBe(true);
      expect(isSavingsDraw(sale)).toBe(true);
      expect(classifyFlow(sale)).toBeNull();
    });

    it('is not income without a category either', () => {
      const sale = drawn('2029-05-01', 5000, 'Brokerage');
      expect(isSavingsDraw(sale)).toBe(true);
      expect(classifyFlow(sale)).toBeNull();
    });

    it('is neither income nor a spending offset when filed under a spending category', () => {
      const sale = {
        ...drawn('2029-05-01', 5000, 'Brokerage', 'Savings'),
        category_is_income: false,
      };
      expect(classifyFlow(sale)).toBeNull();
    });

    it('leaves a transfer between two budget accounts, and real income, alone', () => {
      const between = {
        ...drawn('2029-05-01', 300, 'Savings', 'Starting Balances'),
        transfer_counterpart_off_budget: false,
      };
      expect(isSavingsDraw(between)).toBe(false);
      expect(classifyFlow(between)).toBe('income');
      expect(isSavingsDraw(earned('2029-05-01', 900, 'Boss'))).toBe(false);
    });

    it('is not a draw when money goes the other way', () => {
      const contribution = {
        ...spent('2029-05-01', 300, 'Brokerage', 'Savings', {
          is_transfer: true,
        }),
        transfer_counterpart_off_budget: true,
      };
      expect(isSavingsDraw(contribution)).toBe(false);
      // Saving is still budgeted spending.
      expect(classifyFlow(contribution)).toBe('spending');
    });

    it("is not counted from the tracking account's own side", () => {
      const receiving = {
        ...drawn('2029-05-01', 300, 'Checking', null),
        account_off_budget: true,
        transfer_counterpart_off_budget: false,
      };
      expect(isSavingsDraw(receiving)).toBe(false);
    });
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
