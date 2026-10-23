import { createAmountConverter } from './amounts';
import { normalizeQuery, shapeRow } from './structured-query';
import type { QuerySpec } from './structured-query';

const usd = createAmountConverter('USD');
const jpy = createAmountConverter('JPY');

function normalize(
  spec: Partial<QuerySpec> & { table: string },
  converter = usd,
) {
  return normalizeQuery({ limit: 100, ...spec }, converter.toMinor);
}

describe('select', () => {
  it('uses sensible columns when none are given', () => {
    const { select, columns } = normalize({ table: 'transactions' });

    expect(select).toEqual([
      'id',
      'date',
      'amount',
      'account.name',
      'payee.name',
      'category.name',
      'notes',
      'cleared',
    ]);
    expect(columns.map(column => column.key)).toEqual(select);
    expect(columns.find(column => column.key === 'amount')?.money).toBe(true);
    expect(columns.find(column => column.key === 'notes')?.money).toBe(false);
  });

  it('has defaults for every table', () => {
    for (const table of ['accounts', 'categories', 'payees', 'schedules']) {
      expect(normalize({ table }).select.length, table).toBeGreaterThan(0);
    }
  });

  it('expands * to every field of the table', () => {
    const { select } = normalize({ table: 'payees', select: ['*'] });

    expect(select).toEqual(
      expect.arrayContaining(['id', 'name', 'transfer_acct', 'favorite']),
    );
    expect(select).not.toContain('tombstone');
  });

  it('accepts a leading $ on a field name', () => {
    expect(
      normalize({ table: 'transactions', select: ['$date'] }).select,
    ).toEqual(['date']);
  });

  it('names expressions, and knows which results are money', () => {
    const { select, columns } = normalize({
      table: 'transactions',
      select: [
        { total: { $sum: '$amount' } },
        { size: { $abs: '$amount' } },
        { flipped: { $neg: '$amount' } },
        { n: { $count: '$id' } },
        { month: { $month: '$date' } },
        { name: { $lower: '$payee.name' } },
      ],
    });

    expect(select).toEqual([
      { total: { $sum: '$amount' } },
      { size: { $abs: '$amount' } },
      { flipped: { $neg: '$amount' } },
      { n: { $count: '$id' } },
      { month: { $month: '$date' } },
      { name: { $lower: '$payee.name' } },
    ]);
    expect(columns).toEqual([
      { key: 'total', money: true },
      { key: 'size', money: true },
      { key: 'flipped', money: true },
      { key: 'n', money: false },
      { key: 'month', money: false },
      { key: 'name', money: false },
    ]);
  });

  it('passes function arguments through as a list or a single value, as given', () => {
    const { select } = normalize({
      table: 'transactions',
      select: [{ short: { $substr: ['$notes', 1, 3] } }],
    });

    expect(select).toEqual([{ short: { $substr: ['$notes', 1, 3] } }]);
  });

  it('rejects names that cannot be columns', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        select: [{ 'my total': { $sum: '$amount' } }],
      }),
    ).toThrow('"my total" is not a usable column name');
  });

  it('rejects entries that are neither a field nor a named expression', () => {
    expect(() => normalize({ table: 'transactions', select: [42] })).toThrow(
      'select[0]: expected a field name or a named expression',
    );
    expect(() =>
      normalize({ table: 'transactions', select: [{ a: '$id', b: '$id' }] }),
    ).toThrow('select[0]: expected a field name or a named expression');
  });

  it('rejects a function with several keys', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        select: [{ x: { $sum: '$amount', $count: '$id' } }],
      }),
    ).toThrow('a function is an object with exactly one key');
  });
});

describe('filter: money', () => {
  it('converts amounts to minor units for every comparison operator', () => {
    for (const op of ['$eq', '$ne', '$lt', '$lte', '$gt', '$gte']) {
      expect(
        normalize({
          table: 'transactions',
          filter: { amount: { [op]: -12.34 } },
        }).filter,
      ).toEqual({ amount: { [op]: -1234 } });
    }
  });

  it('converts a bare amount, which means equals', () => {
    expect(
      normalize({ table: 'transactions', filter: { amount: -15.99 } }).filter,
    ).toEqual({
      amount: -1599,
    });
  });

  it('rounds rather than truncates, so 19.99 is 1999 cents', () => {
    expect(
      normalize({ table: 'transactions', filter: { amount: { $eq: 19.99 } } })
        .filter,
    ).toEqual({ amount: { $eq: 1999 } });
  });

  it('follows the currency: yen have no minor unit', () => {
    expect(
      normalize(
        { table: 'transactions', filter: { amount: { $lt: -1500 } } },
        jpy,
      ).filter,
    ).toEqual({ amount: { $lt: -1500 } });
  });

  it('converts through $abs and $neg transforms, which keep the amount an amount', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: { amount: { $transform: '$abs', $gt: 50 } },
      }).filter,
    ).toEqual({ amount: { $transform: '$abs', $gt: 5000 } });
  });

  it('converts inside $and and $or, however deeply nested', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: {
          $or: [{ amount: { $gte: 10 } }, { $and: [{ amount: { $lt: -5 } }] }],
        },
      }).filter,
    ).toEqual({
      $or: [{ amount: { $gte: 1000 } }, { $and: [{ amount: { $lt: -500 } }] }],
    });
  });

  it('leaves numbers on fields that are not money alone', () => {
    expect(
      normalize({ table: 'transactions', filter: { sort_order: { $gt: 100 } } })
        .filter,
    ).toEqual({ sort_order: { $gt: 100 } });
  });

  it('rewrites a list of numbers as separate equals, since the engine cannot match them', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: { amount: { $oneof: [-9.99, -15.99] } },
      }).filter,
    ).toEqual({ $or: [{ amount: { $eq: -999 } }, { amount: { $eq: -1599 } }] });
  });

  it('keeps a transform when it rewrites a list of numbers', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: { amount: { $transform: '$abs', $oneof: [10, 20] } },
      }).filter,
    ).toEqual({
      $or: [
        { amount: { $transform: '$abs', $eq: 1000 } },
        { amount: { $transform: '$abs', $eq: 2000 } },
      ],
    });
  });

  it('keeps a list of text as a $oneof', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: { 'payee.name': { $oneof: ['Costco', 'Netflix'] } },
      }).filter,
    ).toEqual({ 'payee.name': { $oneof: ['Costco', 'Netflix'] } });
  });

  it('refuses an amount written as text', () => {
    expect(() =>
      normalize({ table: 'transactions', filter: { amount: { $lt: '-50' } } }),
    ).toThrow('amounts are numbers in major units');
  });

  it('allows comparing an amount with another field', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: { amount: { $lt: '$sort_order' } },
      }).filter,
    ).toEqual({ amount: { $lt: '$sort_order' } });
  });
});

describe('filter: shape', () => {
  it('keeps a single condition as it is, and joins several with $and', () => {
    expect(
      normalize({ table: 'transactions', filter: { notes: 'rent' } }).filter,
    ).toEqual({ notes: 'rent' });
    expect(
      normalize({
        table: 'transactions',
        filter: { notes: 'rent', cleared: true },
      }).filter,
    ).toEqual({ $and: [{ notes: 'rent' }, { cleared: true }] });
  });

  it('treats a list of operators on one field as all of them', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: { date: [{ $gte: '2026-09-01' }, { $lte: '2026-09-30' }] },
      }).filter,
    ).toEqual({
      $and: [
        { date: { $gte: '2026-09-01' } },
        { date: { $lte: '2026-09-30' } },
      ],
    });
  });

  it('accepts a single condition or a list under $and and $or', () => {
    expect(
      normalize({ table: 'transactions', filter: { $or: { notes: 'a' } } })
        .filter,
    ).toEqual({ $or: { notes: 'a' } });
    expect(
      normalize({
        table: 'transactions',
        filter: { $or: [{ notes: 'a' }, { notes: 'b' }] },
      }).filter,
    ).toEqual({ $or: [{ notes: 'a' }, { notes: 'b' }] });
  });

  it('allows null, for "has no value"', () => {
    expect(
      normalize({
        table: 'transactions',
        filter: { 'category.name': { $ne: null } },
      }).filter,
    ).toEqual({ 'category.name': { $ne: null } });
  });

  it('passes an empty filter through', () => {
    expect(normalize({ table: 'transactions', filter: {} }).filter).toEqual({
      $and: [],
    });
    expect(normalize({ table: 'transactions' }).filter).toBeUndefined();
  });

  it('refuses operators it does not know, naming the ones it does', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { amount: { $between: [1, 2] } },
      }),
    ).toThrow(
      'unknown operator "$between". Operators: $eq, $ne, $lt, $lte, $gt, $gte, $like, $notlike, $regexp, $oneof.',
    );
  });

  it('refuses a condition with no operator or with several', () => {
    expect(() =>
      normalize({ table: 'transactions', filter: { amount: {} } }),
    ).toThrow('use exactly one operator');
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { amount: { $lt: 1, $gt: 0 } },
      }),
    ).toThrow('use exactly one operator');
  });

  it('refuses a stray $ key at the top of a filter', () => {
    expect(() =>
      normalize({ table: 'transactions', filter: { $not: { notes: 'a' } } }),
    ).toThrow('unexpected "$not"');
  });

  it('refuses a transform it does not know', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { date: { $transform: '$dayofweek', $eq: 'x' } },
      }),
    ).toThrow('$transform must be one of');
  });

  it('refuses a value that is a list or an object', () => {
    expect(() =>
      normalize({ table: 'transactions', filter: { notes: { $eq: ['a'] } } }),
    ).toThrow('expected a single value');
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { 'payee.name': { $oneof: 'Costco' } },
      }),
    ).toThrow('expected a list of values');
  });
});

describe('filter: text the engine would not escape', () => {
  it('refuses quotes in values compared with an id field', () => {
    for (const filter of [
      { account: "x' OR 1=1 --" },
      { payee: { $eq: "a'b" } },
      { category: { $ne: "a'b" } },
      { id: { $gt: "a'b" } },
    ]) {
      expect(() => normalize({ table: 'transactions', filter })).toThrow(
        'holds ids',
      );
    }
  });

  it('refuses anything that is not id-shaped for an id field, such as a name', () => {
    expect(() =>
      normalize({ table: 'transactions', filter: { payee: 'Trader Joe' } }),
    ).toThrow('To match by name, filter on "payee.name" instead');
  });

  it('accepts real ids', () => {
    const id = '42c1c158-4869-42f1-b48f-873d6b5b1dbd';
    expect(
      normalize({ table: 'transactions', filter: { account: id } }).filter,
    ).toEqual({
      account: id,
    });
  });

  it('refuses quotes in any $oneof value, whatever the field', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { 'payee.name': { $oneof: ["Trader Joe's"] } },
      }),
    ).toThrow('$oneof values cannot contain a single quote');
  });

  it('allows quotes in text the engine does escape', () => {
    for (const filter of [
      { 'payee.name': "Trader Joe's" },
      { notes: { $like: "%joe's%" } },
      { notes: { $ne: "it's" } },
      { 'payee.name': { $notlike: "%'%" } },
    ]) {
      expect(
        () => normalize({ table: 'transactions', filter }),
        JSON.stringify(filter),
      ).not.toThrow();
    }
  });
});

describe('filter: dates', () => {
  it('accepts real dates in the form the transform expects', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { date: { $gte: '2026-09-01' } },
      }),
    ).not.toThrow();
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { date: { $transform: '$month', $eq: '2026-09' } },
      }),
    ).not.toThrow();
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { date: { $transform: '$year', $eq: '2026' } },
      }),
    ).not.toThrow();
  });

  it.each([
    [{ date: '2026-02-30' }, 'YYYY-MM-DD'],
    [{ date: '09/01/2026' }, 'YYYY-MM-DD'],
    [{ date: '2026-09' }, 'YYYY-MM-DD'],
    [{ date: { $transform: '$month', $eq: '2026-09-01' } }, 'YYYY-MM'],
    [{ date: { $transform: '$month', $eq: '2026-13' } }, 'YYYY-MM'],
    [{ date: { $transform: '$year', $eq: '26' } }, 'YYYY'],
  ])('refuses %j', (filter, format) => {
    expect(() => normalize({ table: 'transactions', filter })).toThrow(
      `is not a date written ${format}`,
    );
  });
});

describe('filter: references to other fields', () => {
  it('checks that a $-reference names a real field', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        filter: { amount: { $lt: '$nothing' } },
      }),
    ).toThrow('unknown field "nothing"');
    expect(() =>
      normalize({ table: 'transactions', filter: { amount: { $lt: '$' } } }),
    ).toThrow('"$" on its own is not a field');
  });
});

describe('group_by and order_by', () => {
  it('accepts fields and functions', () => {
    const { groupBy, orderBy } = normalize({
      table: 'transactions',
      group_by: ['payee.name', '$category.name', { $month: '$date' }],
      order_by: [
        'date',
        { amount: 'desc' },
        { $sum: '$amount', $dir: 'asc' },
        { $month: '$date' },
      ],
    });

    expect(groupBy).toEqual([
      'payee.name',
      'category.name',
      { $month: '$date' },
    ]);
    expect(orderBy).toEqual([
      'date',
      { amount: 'desc' },
      { $sum: '$amount', $dir: 'asc' },
      { $month: '$date' },
    ]);
  });

  it('refuses a group_by entry that is not a field or a function', () => {
    expect(() => normalize({ table: 'transactions', group_by: [5] })).toThrow(
      'group_by[0]: expected a field name or a function',
    );
  });

  it('refuses a bad direction, in either form', () => {
    expect(() =>
      normalize({ table: 'transactions', order_by: [{ date: 'up' }] }),
    ).toThrow('the direction must be "asc" or "desc"');
    expect(() =>
      normalize({
        table: 'transactions',
        order_by: [{ $sum: '$amount', $dir: 'up' }],
      }),
    ).toThrow('$dir must be "asc" or "desc"');
  });

  it('refuses to order by several fields in one entry', () => {
    expect(() =>
      normalize({
        table: 'transactions',
        order_by: [{ date: 'asc', amount: 'asc' }],
      }),
    ).toThrow('order by one field per entry');
  });

  it('refuses unknown fields and functions', () => {
    expect(() =>
      normalize({ table: 'transactions', order_by: ['merchant'] }),
    ).toThrow('unknown field "merchant"');
    expect(() =>
      normalize({ table: 'transactions', group_by: [{ $nope: '$date' }] }),
    ).toThrow('unknown function "$nope"');
  });
});

describe('calculate', () => {
  it('returns one column called result, and knows whether it is money', () => {
    const sum = normalize({
      table: 'transactions',
      calculate: { $sum: '$amount' },
    });
    const count = normalize({
      table: 'transactions',
      calculate: { $count: '$id' },
    });

    expect(sum.calculate).toEqual({ $sum: '$amount' });
    expect(sum.columns).toEqual([{ key: 'result', money: true }]);
    expect(count.columns).toEqual([{ key: 'result', money: false }]);
  });

  it('cannot be combined with select, group_by or order_by', () => {
    for (const extra of [
      { select: ['date'] },
      { group_by: ['date'] },
      { order_by: ['date'] },
    ]) {
      expect(() =>
        normalize({
          table: 'transactions',
          calculate: { $sum: '$amount' },
          ...extra,
        }),
      ).toThrow('calculate returns a single value');
    }
  });

  it('must be a function', () => {
    expect(() => normalize({ table: 'transactions', calculate: {} })).toThrow(
      'a function is an object with exactly one key',
    );
  });
});

describe('tables', () => {
  it('refuses a table that cannot be queried', () => {
    expect(() => normalize({ table: 'preferences' })).toThrow(
      'unknown table "preferences"',
    );
  });

  it('uses the right field list for each table', () => {
    expect(() =>
      normalize({ table: 'accounts', select: ['offbudget'] }),
    ).not.toThrow();
    expect(() => normalize({ table: 'payees', select: ['offbudget'] })).toThrow(
      'unknown field "offbudget" on table "payees"',
    );
  });
});

describe('shapeRow', () => {
  const columns = [
    { key: 'date', money: false },
    { key: 'amount', money: true },
  ];

  it('keeps only the requested columns, dropping the id the engine adds', () => {
    expect(
      shapeRow(
        { id: 'abc', date: '2026-09-01', amount: -1599, extra: 1 },
        columns,
        usd.toMajor,
      ),
    ).toEqual({ date: '2026-09-01', amount: -15.99 });
  });

  it('converts money back to major units', () => {
    expect(
      shapeRow({ date: 'd', amount: 123456 }, columns, usd.toMajor).amount,
    ).toBe(1234.56);
    expect(
      shapeRow({ date: 'd', amount: 1500 }, columns, jpy.toMajor).amount,
    ).toBe(1500);
  });

  it('converts a range of amounts', () => {
    expect(
      shapeRow(
        { _amount: { num1: -6000, num2: -4000 } },
        [{ key: '_amount', money: true }],
        usd.toMajor,
      ),
    ).toEqual({ _amount: { num1: -60, num2: -40 } });
  });

  it('leaves null and missing values empty rather than inventing zero', () => {
    expect(shapeRow({ date: null }, columns, usd.toMajor)).toEqual({
      date: null,
      amount: null,
    });
  });

  it('does not convert columns that are not money', () => {
    expect(
      shapeRow({ n: 3 }, [{ key: 'n', money: false }], usd.toMajor),
    ).toEqual({ n: 3 });
  });
});
