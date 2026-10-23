import * as api from '@actual-app/api';

import { toolError } from '#errors';

import { createAmountConverter } from './amounts';
import type { Lookups } from './lookup';
import { toRuleActions, toRuleConditions } from './rule-input';
import type { ConditionInput } from './rule-input';
import type { ActualContext } from './session';

// Only the amount converter is used, so no budget is needed.
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

const KNOWN = {
  category: ['Food', 'General'],
  payee: ['Costco', 'Netflix'],
  account: ['Checking'],
};

// Names resolve to `kind:name`, and anything else is unknown.
function fakeLookups(): Lookups {
  const resolve = (kind: keyof typeof KNOWN) => async (text: string) => {
    const known = KNOWN[kind].find(
      name => name.toLowerCase() === text.trim().toLowerCase(),
    );
    if (!known) throw toolError(`unknown ${kind} "${text}".`);
    return { id: `${kind}:${known}`, name: known };
  };
  return {
    category: resolve('category'),
    payee: resolve('payee'),
    account: resolve('account'),
  };
}

const convert = (conditions: ConditionInput[]) =>
  toRuleConditions(ctx, fakeLookups(), conditions);

describe('toRuleConditions', () => {
  it('turns names into ids and major units into minor units', async () => {
    const { conditions, warnings } = await convert([
      { field: 'payee', op: 'is', value: 'costco' },
      { field: 'amount', op: 'lt', value: -100.25 },
      { field: 'amount', op: 'isbetween', value: { num1: -50, num2: -10.5 } },
      { field: 'date', op: 'gte', value: '2026-09-01' },
      { field: 'account', op: 'oneOf', value: ['Checking', 'checking'] },
      { field: 'imported_payee', op: 'contains', value: 'amzn' },
    ]);

    expect(conditions).toEqual([
      { field: 'payee', op: 'is', value: 'payee:Costco' },
      { field: 'amount', op: 'lt', value: -10025 },
      { field: 'amount', op: 'isbetween', value: { num1: -5000, num2: -1050 } },
      { field: 'date', op: 'gte', value: '2026-09-01' },
      { field: 'account', op: 'oneOf', value: ['account:Checking'] },
      { field: 'imported_payee', op: 'contains', value: 'amzn' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('accepts null as "no category yet", for a category only', async () => {
    const { conditions } = await convert([
      { field: 'category', op: 'is', value: null },
    ]);
    expect(conditions).toEqual([{ field: 'category', op: 'is', value: null }]);

    await expect(
      convert([{ field: 'payee', op: 'is', value: null }]),
    ).rejects.toThrow(/conditions\[0\]: is needs one payee name or id/);
  });

  it('names the operators a field does support when asked for one it does not', async () => {
    await expect(
      convert([{ field: 'payee', op: 'contains', value: 'cost' }]),
    ).rejects.toThrow(
      /conditions\[0\]: contains is not available for payee; payee supports is, isNot, oneOf, notOneOf/,
    );
    await expect(
      convert([{ field: 'date', op: 'contains', value: '2026' }]),
    ).rejects.toThrow(/date supports is, gt, gte, lt, lte/);
  });

  it('points at the condition that is wrong', async () => {
    await expect(
      convert([
        { field: 'payee', op: 'is', value: 'Costco' },
        { field: 'category', op: 'is', value: 'Nope' },
      ]),
    ).rejects.toThrow('unknown category "Nope"');
    await expect(
      convert([
        { field: 'payee', op: 'is', value: 'Costco' },
        { field: 'date', op: 'is', value: '2026-02-30' },
      ]),
    ).rejects.toThrow(/conditions\[1\]: is needs a date written YYYY-MM-DD/);
    await expect(
      convert([{ field: 'amount', op: 'lt', value: 'cheap' }]),
    ).rejects.toThrow(/lt needs a number in major units/);
    await expect(
      convert([{ field: 'amount', op: 'isbetween', value: -5 }]),
    ).rejects.toThrow(/isbetween needs a value like/);
    await expect(
      convert([{ field: 'notes', op: 'oneOf', value: 'x' }]),
    ).rejects.toThrow(/notes supports is, isNot, contains/);
    await expect(
      convert([{ field: 'payee', op: 'oneOf', value: [] }]),
    ).rejects.toThrow(/oneOf needs a non-empty list of payee names or ids/);
  });

  it('wants between one and ten conditions', async () => {
    await expect(convert([])).rejects.toThrow(/between 1 and 10 conditions/);
    const eleven = Array.from({ length: 11 }, () => ({
      field: 'amount' as const,
      op: 'lt' as const,
      value: -1,
    }));
    await expect(convert(eleven)).rejects.toThrow(/between 1 and 10/);
  });

  it('requires regular expressions to be valid and lowercase', async () => {
    await expect(
      convert([{ field: 'notes', op: 'matches', value: '^Rent \\D' }]),
    ).rejects.toThrow(/write it in lowercase/);
    await expect(
      convert([{ field: 'notes', op: 'matches', value: '(' }]),
    ).rejects.toThrow(/not a valid regular expression/);

    const { conditions } = await convert([
      { field: 'notes', op: 'matches', value: '^rent \\d+' },
    ]);
    expect(conditions[0]).toMatchObject({ op: 'matches', value: '^rent \\d+' });
  });

  it('warns that a percent sign in a text search is a wildcard in previews', async () => {
    const { warnings } = await convert([
      { field: 'notes', op: 'contains', value: '100%' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/conditions\[0\].*wildcard/);
  });
});

describe('toRuleActions', () => {
  it('turns names into ids and keeps note text exactly as given', async () => {
    const actions = await toRuleActions(fakeLookups(), [
      { op: 'set', field: 'category', value: 'food' },
      { op: 'set', field: 'payee', value: 'Costco' },
      { op: 'set', field: 'notes', value: 'groceries' },
      { op: 'append-notes', value: ' [auto]' },
      { op: 'prepend-notes', value: '* ', field: 'notes' },
    ]);

    expect(actions).toEqual([
      { op: 'set', field: 'category', value: 'category:Food' },
      { op: 'set', field: 'payee', value: 'payee:Costco' },
      { op: 'set', field: 'notes', value: 'groceries' },
      { op: 'append-notes', value: ' [auto]' },
      { op: 'prepend-notes', value: '* ' },
    ]);
  });

  it('refuses what it cannot preview exactly', async () => {
    const lookups = fakeLookups();
    await expect(
      toRuleActions(lookups, [{ op: 'set', value: 'Food' }]),
    ).rejects.toThrow(/actions\[0\]: set needs a field/);
    await expect(
      toRuleActions(lookups, [
        { op: 'set', field: 'category', value: 'Food' },
        { op: 'set', field: 'category', value: 'General' },
      ]),
    ).rejects.toThrow(
      /actions\[1\]: there is already an action that sets category/,
    );
    await expect(
      toRuleActions(lookups, [
        { op: 'append-notes', field: 'category', value: 'x' },
      ]),
    ).rejects.toThrow(/append-notes only works on the notes/);
    await expect(
      toRuleActions(lookups, [{ op: 'set', field: 'category', value: '  ' }]),
    ).rejects.toThrow(/value must not be empty/);
    await expect(toRuleActions(lookups, [])).rejects.toThrow(
      /between 1 and 5 actions/,
    );
    await expect(
      toRuleActions(lookups, [{ op: 'set', field: 'category', value: 'Nope' }]),
    ).rejects.toThrow('unknown category "Nope"');
  });
});
