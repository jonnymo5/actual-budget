import {
  assertQueryableTable,
  isQueryableTable,
  listFields,
  QUERYABLE_TABLES,
  resolveField,
} from './aql-schema';

describe('queryable tables', () => {
  it('are the five the tools document', () => {
    expect([...QUERYABLE_TABLES]).toEqual([
      'transactions',
      'accounts',
      'categories',
      'payees',
      'schedules',
    ]);
  });

  it.each(['transactions', 'schedules'])('accepts %s', table => {
    expect(isQueryableTable(table)).toBe(true);
    expect(assertQueryableTable(table)).toBe(table);
  });

  it.each([
    'preferences',
    'rules',
    'notes',
    'category_groups',
    'TRANSACTIONS',
    '',
  ])('refuses %j, and says what is allowed', table => {
    expect(isQueryableTable(table)).toBe(false);
    expect(() => assertQueryableTable(table)).toThrow(
      `unknown table "${table}". Queryable tables: transactions, accounts, categories, payees, schedules.`,
    );
  });
});

describe('listFields', () => {
  it('lists what the engine really has, without bookkeeping or raw bank data', () => {
    const fields = listFields('transactions');

    expect(fields).toEqual(
      expect.arrayContaining([
        'id',
        'date',
        'amount',
        'account',
        'payee',
        'category',
        'notes',
      ]),
    );
    for (const hidden of ['tombstone', 'raw_synced_data', 'error']) {
      expect(fields).not.toContain(hidden);
    }
    expect(listFields('schedules')).not.toContain('_conditions');
    expect(listFields('accounts')).not.toContain('account_id');
  });
});

describe('resolveField', () => {
  it('finds a plain field and its type', () => {
    expect(resolveField('transactions', 'date')).toEqual({
      table: 'transactions',
      name: 'date',
      type: 'date',
      ref: undefined,
      money: false,
    });
  });

  it('marks money fields, and only those', () => {
    expect(resolveField('transactions', 'amount').money).toBe(true);
    expect(resolveField('schedules', '_amount').money).toBe(true);
    expect(resolveField('transactions', 'sort_order').money).toBe(false);
    expect(resolveField('transactions', 'imported_id').money).toBe(false);
  });

  it('follows references to the field they lead to', () => {
    expect(resolveField('transactions', 'payee.name')).toMatchObject({
      table: 'payees',
      name: 'name',
      type: 'string',
    });
    expect(resolveField('transactions', 'category.group.name')).toMatchObject({
      table: 'category_groups',
      name: 'name',
    });
    expect(resolveField('schedules', '_payee.name').table).toBe('payees');
  });

  it('reports a reference field itself as an id that points somewhere', () => {
    expect(resolveField('transactions', 'payee')).toMatchObject({
      type: 'id',
      ref: 'payees',
    });
  });

  it('does not take money from a field with the same name on another table', () => {
    // `amount` on a joined table is not a transaction amount.
    expect(resolveField('transactions', 'schedule._amount').money).toBe(true);
    expect(resolveField('schedules', 'name').money).toBe(false);
  });

  it('suggests the field a near miss was probably meant to be', () => {
    expect(() => resolveField('transactions', 'payee_name')).toThrow(
      'Did you mean: payee, payee.name?',
    );
    expect(() => resolveField('transactions', 'payeeName')).toThrow(
      'Did you mean: payee, payee.name?',
    );
    expect(() => resolveField('transactions', 'categoryName')).toThrow(
      'Did you mean: category, category.name?',
    );
  });

  it('lists the fields when nothing is close, and explains references', () => {
    expect(() => resolveField('transactions', 'merchant')).toThrow(
      /Fields: id, .*Follow a reference with a dot/,
    );
  });

  it('says which table a bad step was on, and how it was reached', () => {
    expect(() => resolveField('transactions', 'payee.nme')).toThrow(
      'unknown field "nme" on table "payees" (reached through "payee")',
    );
  });

  it('refuses to read a sub-field of a plain field', () => {
    expect(() => resolveField('transactions', 'amount.value')).toThrow(
      '"amount" is a plain integer field, so "value" cannot be read from it',
    );
  });

  it.each([
    '',
    '.',
    'payee.',
    '.name',
    'tombstone',
    'raw_synced_data',
    'payee.tombstone',
  ])('refuses the path %j', path => {
    expect(() => resolveField('transactions', path)).toThrow();
  });
});
