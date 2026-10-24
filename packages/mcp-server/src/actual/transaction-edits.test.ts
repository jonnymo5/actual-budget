import * as api from '@actual-app/api';

import { createAmountConverter } from './amounts';
import type { ActualContext } from './session';
import {
  appendToNotes,
  planEdit,
  prependToNotes,
  reconciledWarning,
  toSample,
  totalByNewCategory,
} from './transaction-edits';
import type { EditableTransaction, PlannedEdit } from './transaction-edits';

const ctx: ActualContext = {
  api,
  lootCore: {
    send: async () => {
      throw new Error('this test has no budget');
    },
  },
  amounts: createAmountConverter('USD'),
  budget: { id: 'b', name: 'Test' },
  syncStatus: () => ({ lastSyncedAt: null, lastError: null }),
  today: () => '2026-01-15',
};

const FOOD = { id: 'cat-food', name: 'Food' };
const FUN = { id: 'cat-fun', name: 'Fun' };

function transaction(
  overrides: Partial<EditableTransaction> = {},
): EditableTransaction {
  return {
    id: 't1',
    date: '2026-10-01',
    amount: -12.5,
    account: 'Checking',
    account_off_budget: false,
    payee_id: 'p1',
    payee: 'Costco',
    category_id: null,
    category: null,
    notes: null,
    is_transfer: false,
    is_split_parent: false,
    reconciled: false,
    ...overrides,
  };
}

describe('planEdit', () => {
  it('describes a category change with the old and the new name', () => {
    const plan = planEdit(
      transaction({ category_id: 'cat-fun', category: 'Fun' }),
      { category: FOOD },
    );

    expect(plan.kind).toBe('change');
    if (plan.kind !== 'change') return;
    expect(plan.edit.fields).toEqual({ category: 'cat-food' });
    expect(plan.edit.changes).toEqual([
      { field: 'category', from: 'Fun', to: 'Food' },
    ]);
  });

  it('has nothing to do when the transaction already has the values', () => {
    expect(
      planEdit(transaction({ category_id: 'cat-food', category: 'Food' }), {
        category: FOOD,
        payee: { id: 'p1', name: 'Costco' },
        notes: current => current,
      }),
    ).toEqual({ kind: 'unchanged' });
  });

  it('skips what Actual does not categorize, with the reason', () => {
    const wanted = { category: FOOD };
    expect(planEdit(transaction({ is_transfer: true }), wanted)).toMatchObject({
      kind: 'skip',
      reason: expect.stringMatching(/transfer between accounts/),
    });
    expect(
      planEdit(transaction({ account_off_budget: true }), wanted),
    ).toMatchObject({
      kind: 'skip',
      reason: expect.stringMatching(/off-budget account/),
    });
    expect(
      planEdit(transaction({ is_split_parent: true }), wanted),
    ).toMatchObject({
      kind: 'skip',
      reason: expect.stringMatching(/split transaction/),
    });
  });

  it('lets notes change anywhere, since they are not tied to a category', () => {
    const plan = planEdit(
      transaction({ is_transfer: true, account_off_budget: true }),
      { notes: () => 'moved' },
    );
    expect(plan.kind).toBe('change');
  });

  it('clears notes with an empty string', () => {
    const plan = planEdit(transaction({ notes: 'old' }), { notes: () => '' });
    expect(plan.kind === 'change' && plan.edit.fields).toEqual({ notes: '' });
  });
});

describe('note edits', () => {
  it('add text once, however often they run', () => {
    const append = appendToNotes(' [auto]');
    expect(append(null)).toBe(' [auto]');
    expect(append('groceries')).toBe('groceries [auto]');
    expect(append(append('groceries'))).toBe('groceries [auto]');

    const prepend = prependToNotes('* ');
    expect(prepend('groceries')).toBe('* groceries');
    expect(prepend(prepend('groceries'))).toBe('* groceries');
  });
});

describe('summaries', () => {
  function edit(id: string, amount: number, reconciled = false): PlannedEdit {
    const plan = planEdit(transaction({ id, amount, reconciled }), {
      category: id === 'a' || id === 'b' ? FOOD : FUN,
    });
    if (plan.kind !== 'change') throw new Error('expected a change');
    return plan.edit;
  }

  it('totals the money per new category, most transactions first', () => {
    const totals = totalByNewCategory(ctx, [
      edit('a', -0.1),
      edit('b', -0.2),
      edit('c', -50),
    ]);

    expect(totals).toEqual([
      {
        category_id: 'cat-food',
        category: 'Food',
        count: 2,
        total_amount: -0.3,
      },
      { category_id: 'cat-fun', category: 'Fun', count: 1, total_amount: -50 },
    ]);
  });

  it('flags reconciled transactions', () => {
    expect(reconciledWarning([edit('a', -1), edit('b', -1)])).toEqual([]);
    expect(reconciledWarning([edit('a', -1, true), edit('b', -1)])).toEqual([
      expect.stringMatching(/^1 of these transactions are reconciled/),
    ]);
  });

  it('shows a transaction and what changes about it', () => {
    expect(toSample(edit('c', -50))).toEqual({
      id: 'c',
      date: '2026-10-01',
      amount: -50,
      account: 'Checking',
      payee: 'Costco',
      changes: [{ field: 'category', from: null, to: 'Fun' }],
    });
  });
});
