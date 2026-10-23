import { z } from 'zod';

import { toolError } from '#errors';

import { isValidIsoDate, isValidIsoMonth } from './amounts';
import { assertQueryableTable, listFields, resolveField } from './aql-schema';
import type { QueryableTable, ResolvedField } from './aql-schema';
import type { ActualContext } from './session';

// ActualQL is the engine's own query language. This module takes a query as
// plain JSON, checks every table, field, operator and function against what
// the engine really has, and converts money between the major units callers
// use and the integer minor units the engine stores.
//
// It also guards the two places where the engine builds SQL without escaping
// a caller's text: values compared with an id field, and the values of a
// `$oneof`. Everything else the engine escapes properly.

export type QuerySpec = {
  table: string;
  filter?: Record<string, unknown>;
  select?: unknown[];
  group_by?: unknown[];
  order_by?: unknown[];
  calculate?: Record<string, unknown>;
  limit: number;
};

/** An output column, and whether its values are money to convert back. */
export type Column = { key: string; money: boolean };

type Entry = string | Record<string, unknown>;

export type NormalizedQuery = {
  table: QueryableTable;
  filter: Record<string, unknown> | undefined;
  calculate: Record<string, unknown> | undefined;
  select: Entry[];
  groupBy: Entry[];
  orderBy: Entry[];
  columns: Column[];
  limit: number;
};

type Scope = { table: QueryableTable; toMinor: (major: number) => number };

const ID_SHAPED = /^[\w-]{1,64}$/;
const ALIAS = /^[A-Za-z_]\w*$/;

const COMPARISON_OPS = ['$eq', '$ne', '$lt', '$lte', '$gt', '$gte'];
const FILTER_OPS = new Set([
  ...COMPARISON_OPS,
  '$like',
  '$notlike',
  '$regexp',
  '$oneof',
]);
const TRANSFORMS = new Set([
  '$day',
  '$month',
  '$year',
  '$lower',
  '$abs',
  '$neg',
]);
const FUNCTIONS = new Set([
  '$sum',
  '$count',
  '$abs',
  '$neg',
  '$lower',
  '$substr',
  '$day',
  '$month',
  '$year',
]);
// Functions whose result is money when their input is.
const MONEY_PRESERVING = new Set(['$sum', '$abs', '$neg']);

const DEFAULT_SELECT: Record<QueryableTable, string[]> = {
  transactions: [
    'id',
    'date',
    'amount',
    'account.name',
    'payee.name',
    'category.name',
    'notes',
    'cleared',
  ],
  accounts: ['id', 'name', 'offbudget', 'closed'],
  categories: ['id', 'name', 'is_income', 'hidden', 'group.name'],
  payees: ['id', 'name', 'transfer_acct'],
  schedules: [
    'id',
    'name',
    'next_date',
    'completed',
    '_payee.name',
    '_account.name',
    '_amount',
    '_amountOp',
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function resolveRef(scope: Scope, ref: string, path: string): ResolvedField {
  const name = ref.slice(1);
  if (name === '') {
    throw toolError(
      `${path}: "$" on its own is not a field; put the field name after it, like "$amount".`,
    );
  }
  return resolveField(scope.table, name);
}

//// Filters

type OperandContext = {
  /** The key as written, for messages. */
  fieldPath: string;
  transform: string | undefined;
  inList: boolean;
};

function operand(
  scope: Scope,
  field: ResolvedField,
  value: unknown,
  path: string,
  context: OperandContext,
): unknown {
  if (value === null || typeof value === 'boolean') return value;

  const keepsMoney =
    context.transform === undefined ||
    context.transform === '$abs' ||
    context.transform === '$neg';

  if (typeof value === 'number') {
    return field.money && keepsMoney ? scope.toMinor(value) : value;
  }

  if (typeof value !== 'string') {
    throw toolError(
      `${path}: expected a single value (text, number, true/false or null), got ${show(value)}.`,
    );
  }

  // A string starting with $ is a reference to another field.
  if (value.startsWith('$')) {
    resolveRef(scope, value, path);
    return value;
  }

  if (context.inList && value.includes("'")) {
    throw toolError(
      `${path}: $oneof values cannot contain a single quote (${show(value)}). Combine separate conditions with $or instead.`,
    );
  }
  if (field.money && keepsMoney) {
    throw toolError(
      `${path}: amounts are numbers in major units, like -12.5; got ${show(value)}.`,
    );
  }
  if (
    field.type === 'id' &&
    context.transform === undefined &&
    !ID_SHAPED.test(value)
  ) {
    throw toolError(
      `${path}: "${context.fieldPath}" holds ids (letters, digits, "-" and "_"), and ${show(value)} is not one.${
        field.ref
          ? ` To match by name, filter on "${context.fieldPath}.name" instead.`
          : ''
      }`,
    );
  }
  if (field.type === 'date') {
    const valid =
      context.transform === '$month'
        ? isValidIsoMonth(value)
        : context.transform === '$year'
          ? /^\d{4}$/.test(value)
          : isValidIsoDate(value);
    if (!valid) {
      const format =
        context.transform === '$month'
          ? 'YYYY-MM'
          : context.transform === '$year'
            ? 'YYYY'
            : 'YYYY-MM-DD';
      throw toolError(
        `${path}: ${show(value)} is not a date written ${format}.`,
      );
    }
  }
  return value;
}

// Each field's condition becomes a list of standalone conditions that must all
// hold, so one that needs rewriting can become an $or without disturbing the
// others.
function condition(
  scope: Scope,
  field: ResolvedField,
  fieldPath: string,
  value: unknown,
  path: string,
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    // A list of operator objects means all of them must hold.
    return value.map((item, index) =>
      operatorObject(scope, field, fieldPath, item, `${path}[${index}]`),
    );
  }
  if (isRecord(value)) {
    return [operatorObject(scope, field, fieldPath, value, path)];
  }
  // A bare value means "equals".
  const bare = operand(scope, field, value, path, {
    fieldPath,
    transform: undefined,
    inList: false,
  });
  return [{ [fieldPath]: bare }];
}

function operatorObject(
  scope: Scope,
  field: ResolvedField,
  fieldPath: string,
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw toolError(
      `${path}: expected an operator like {"$gte": 5}, got ${show(value)}.`,
    );
  }
  const { $transform, ...rest } = value;
  const ops = Object.keys(rest);
  if (ops.length !== 1) {
    throw toolError(
      `${path}: use exactly one operator (${[...FILTER_OPS].join(', ')}); got ${ops.length === 0 ? 'none' : ops.join(', ')}. Combine conditions with $and or $or.`,
    );
  }
  const [op] = ops;
  if (!FILTER_OPS.has(op)) {
    throw toolError(
      `${path}: unknown operator "${op}". Operators: ${[...FILTER_OPS].join(', ')}.`,
    );
  }

  let transform: string | undefined;
  if ($transform !== undefined) {
    if (typeof $transform !== 'string' || !TRANSFORMS.has($transform)) {
      throw toolError(
        `${path}: $transform must be one of ${[...TRANSFORMS].join(', ')}; got ${show($transform)}.`,
      );
    }
    transform = $transform;
  }
  const withTransform = (operator: Record<string, unknown>) => ({
    ...(transform ? { $transform: transform } : {}),
    ...operator,
  });

  const raw = rest[op];
  if (op !== '$oneof') {
    const converted = operand(scope, field, raw, `${path}.${op}`, {
      fieldPath,
      transform,
      inList: false,
    });
    return { [fieldPath]: withTransform({ [op]: converted }) };
  }

  if (!Array.isArray(raw)) {
    throw toolError(
      `${path}.$oneof: expected a list of values, got ${show(raw)}.`,
    );
  }
  const items = raw.map((item, index) =>
    operand(scope, field, item, `${path}.$oneof[${index}]`, {
      fieldPath,
      transform,
      inList: true,
    }),
  );
  // The engine writes every $oneof value as text, which never equals a number
  // once the data has passed through a view, so match numbers one by one.
  if (items.some(item => typeof item === 'number')) {
    return {
      $or: items.map(item => ({ [fieldPath]: withTransform({ $eq: item }) })),
    };
  }
  return { [fieldPath]: withTransform({ $oneof: items }) };
}

function filterNode(
  scope: Scope,
  node: unknown,
  path: string,
): Record<string, unknown> {
  if (!isRecord(node)) {
    throw toolError(
      `${path}: expected an object of conditions, got ${show(node)}.`,
    );
  }

  const parts: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === '$and' || key === '$or') {
      parts.push({
        [key]: Array.isArray(value)
          ? value.map((item, index) =>
              filterNode(scope, item, `${path}.${key}[${index}]`),
            )
          : filterNode(scope, value, `${path}.${key}`),
      });
    } else if (key.startsWith('$')) {
      throw toolError(
        `${path}: unexpected "${key}". Combine conditions with $and or $or, or use a field name with an operator, like {"amount": {"$lt": -50}}.`,
      );
    } else {
      const field = resolveField(scope.table, key);
      parts.push(...condition(scope, field, key, value, `${path}.${key}`));
    }
  }
  return parts.length === 1 ? parts[0] : { $and: parts };
}

//// Expressions: select, group_by, order_by, calculate

type Expression = { value: unknown; money: boolean };

function expression(scope: Scope, expr: unknown, path: string): Expression {
  if (expr === null || typeof expr === 'number' || typeof expr === 'boolean') {
    return { value: expr, money: false };
  }

  if (typeof expr === 'string') {
    if (expr.startsWith('$')) {
      const field = resolveRef(scope, expr, path);
      return { value: expr, money: field.money };
    }
    // Without a leading $ this is a literal string, so a bare field name is
    // almost certainly a mistake that would silently return a constant.
    let isFieldName = true;
    try {
      resolveField(scope.table, expr);
    } catch {
      isFieldName = false;
    }
    if (isFieldName) {
      throw toolError(
        `${path}: "${expr}" is a field name, but text without a leading $ is a literal string. Write "$${expr}" to use the field's value.`,
      );
    }
    return { value: expr, money: false };
  }

  if (Array.isArray(expr) || !isRecord(expr)) {
    throw toolError(
      `${path}: expected a field like "$amount", a value, or a function like {"$sum": "$amount"}; got ${show(expr)}.`,
    );
  }

  const entries = Object.entries(expr);
  if (entries.length !== 1) {
    throw toolError(
      `${path}: a function is an object with exactly one key, like {"$sum": "$amount"}; got ${entries.length} keys.`,
    );
  }
  const [name, args] = entries[0];
  if (!FUNCTIONS.has(name)) {
    throw toolError(
      `${path}: unknown function "${name}". Functions: ${[...FUNCTIONS].join(', ')}.`,
    );
  }
  const list = (Array.isArray(args) ? args : [args]).map((arg, index) =>
    expression(scope, arg, `${path}.${name}[${index}]`),
  );
  const values = list.map(item => item.value);
  return {
    value: { [name]: Array.isArray(args) ? values : values[0] },
    money: MONEY_PRESERVING.has(name) && list.some(item => item.money),
  };
}

function fieldName(scope: Scope, text: string) {
  const written = text.startsWith('$') ? text.slice(1) : text;
  return { ...resolveField(scope.table, written), written };
}

function selectEntries(scope: Scope, select: unknown[]) {
  const entries: Entry[] = [];
  const columns: Column[] = [];

  select.forEach((item, index) => {
    const path = `select[${index}]`;
    if (typeof item === 'string') {
      if (item === '*') {
        for (const name of listFields(scope.table)) {
          entries.push(name);
          columns.push({
            key: name,
            money: resolveField(scope.table, name).money,
          });
        }
        return;
      }
      const field = fieldName(scope, item);
      entries.push(field.written);
      columns.push({ key: field.written, money: field.money });
      return;
    }

    if (!isRecord(item) || Object.keys(item).length !== 1) {
      throw toolError(
        `${path}: expected a field name or a named expression with one key, like {"total": {"$sum": "$amount"}}; got ${show(item)}.`,
      );
    }
    const [alias, value] = Object.entries(item)[0];
    if (alias.startsWith('$')) {
      throw toolError(
        `${path}: give the expression a name, like {"total": ${show(item)}}, rather than writing the function on its own.`,
      );
    }
    if (!ALIAS.test(alias)) {
      throw toolError(
        `${path}: "${alias}" is not a usable column name; use letters, digits and "_", starting with a letter.`,
      );
    }
    if (
      typeof value === 'string' &&
      value.startsWith('$') &&
      value.includes('.')
    ) {
      const name = value.slice(1);
      resolveField(scope.table, name);
      throw toolError(
        `${path}: an alias cannot point straight at "${value}", a field reached through a reference. List "${name}" as a plain field (the column is then named "${name}"), or wrap it in a function such as {"${alias}": {"$lower": "${value}"}}.`,
      );
    }
    const expr = expression(scope, value, `${path}.${alias}`);
    entries.push({ [alias]: expr.value });
    columns.push({ key: alias, money: expr.money });
  });

  return { entries, columns };
}

function groupEntries(scope: Scope, groupBy: unknown[]): Entry[] {
  return groupBy.map((item, index) => {
    const path = `group_by[${index}]`;
    if (typeof item === 'string') return fieldName(scope, item).written;
    if (!isRecord(item)) {
      throw toolError(
        `${path}: expected a field name or a function like {"$month": "$date"}; got ${show(item)}.`,
      );
    }
    const expr = expression(scope, item, path);
    if (!isRecord(expr.value)) {
      throw toolError(`${path}: expected a function like {"$month": "$date"}.`);
    }
    return expr.value;
  });
}

function orderEntries(scope: Scope, orderBy: unknown[]): Entry[] {
  return orderBy.map((item, index) => {
    const path = `order_by[${index}]`;
    if (typeof item === 'string') return fieldName(scope, item).written;
    if (!isRecord(item)) {
      throw toolError(
        `${path}: expected a field name, {"field": "desc"} or a function like {"$sum": "$amount", "$dir": "desc"}; got ${show(item)}.`,
      );
    }

    const entries = Object.entries(item);
    const isFunction =
      entries.length > 0 && entries.some(([key]) => key.startsWith('$'));
    if (!isFunction) {
      if (entries.length !== 1) {
        throw toolError(
          `${path}: order by one field per entry, like {"date": "desc"}; got ${entries.length} keys.`,
        );
      }
      const [key, direction] = entries[0];
      if (direction !== 'asc' && direction !== 'desc') {
        throw toolError(
          `${path}: the direction must be "asc" or "desc"; got ${show(direction)}.`,
        );
      }
      return { [fieldName(scope, key).written]: direction };
    }

    const { $dir, ...func } = item;
    if ($dir !== undefined && $dir !== 'asc' && $dir !== 'desc') {
      throw toolError(
        `${path}: $dir must be "asc" or "desc"; got ${show($dir)}.`,
      );
    }
    const expr = expression(scope, func, path);
    if (!isRecord(expr.value)) {
      throw toolError(`${path}: expected a function like {"$sum": "$amount"}.`);
    }
    return { ...expr.value, ...($dir === undefined ? {} : { $dir }) };
  });
}

/**
 * Checks a query against the schema and converts its money to minor units.
 * Throws an error written for the caller when something is wrong.
 */
export function normalizeQuery(
  spec: QuerySpec,
  toMinor: (major: number) => number,
): NormalizedQuery {
  const table = assertQueryableTable(spec.table);
  const scope: Scope = { table, toMinor };

  if (
    spec.calculate !== undefined &&
    (spec.select !== undefined ||
      spec.group_by !== undefined ||
      spec.order_by !== undefined)
  ) {
    throw toolError(
      'calculate returns a single value, so it cannot be combined with select, group_by or order_by. For one row per group, use select with an aggregate and group_by.',
    );
  }

  const filter =
    spec.filter === undefined
      ? undefined
      : filterNode(scope, spec.filter, 'filter');

  if (spec.calculate !== undefined) {
    const expr = expression(scope, spec.calculate, 'calculate');
    if (!isRecord(expr.value)) {
      throw toolError(
        'calculate: expected a function like {"$sum": "$amount"}.',
      );
    }
    return {
      table,
      filter,
      calculate: expr.value,
      select: [],
      groupBy: [],
      orderBy: [],
      columns: [{ key: 'result', money: expr.money }],
      limit: 1,
    };
  }

  const { entries, columns } = selectEntries(
    scope,
    spec.select ?? DEFAULT_SELECT[table],
  );
  return {
    table,
    filter,
    calculate: undefined,
    select: entries,
    groupBy: groupEntries(scope, spec.group_by ?? []),
    orderBy: orderEntries(scope, spec.order_by ?? []),
    columns,
    limit: spec.limit,
  };
}

//// Running

const numbersSchema = z.object({ num1: z.number(), num2: z.number() });

function toMajorValue(
  value: unknown,
  toMajor: (minor: number) => number,
): unknown {
  if (typeof value === 'number') return toMajor(value);
  const range = numbersSchema.safeParse(value);
  if (range.success) {
    return { num1: toMajor(range.data.num1), num2: toMajor(range.data.num2) };
  }
  return value;
}

/**
 * Keeps only the requested columns (the engine adds an `id` to plain rows) and
 * converts the money ones back to major units.
 */
export function shapeRow(
  row: Record<string, unknown>,
  columns: Column[],
  toMajor: (minor: number) => number,
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column.key] ?? null;
    shaped[column.key] = column.money ? toMajorValue(value, toMajor) : value;
  }
  return shaped;
}

export type QueryResult = {
  rows: Record<string, unknown>[];
  columns: Column[];
  /** True when more rows exist than `limit`. */
  truncated: boolean;
  limit: number;
};

const resultSchema = z.object({ data: z.unknown() });
const rowsSchema = z.array(z.record(z.string(), z.unknown()));

export async function runStructuredQuery(
  ctx: ActualContext,
  spec: QuerySpec,
): Promise<QueryResult> {
  const normalized = normalizeQuery(spec, ctx.amounts.toMinor);

  let query = ctx.api.q(normalized.table);
  if (normalized.filter) query = query.filter(normalized.filter);
  if (normalized.calculate) {
    query = query.calculate(normalized.calculate);
  } else {
    query = query.select(normalized.select);
    if (normalized.groupBy.length > 0) {
      query = query.groupBy(normalized.groupBy);
    }
    if (normalized.orderBy.length > 0) {
      query = query.orderBy(normalized.orderBy);
    }
    // One extra row tells us whether the limit cut anything off.
    query = query.limit(normalized.limit + 1);
  }

  let data: unknown;
  try {
    data = resultSchema.parse(await ctx.api.aqlQuery(query)).data;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw toolError(`The query was rejected by Actual: ${reason}`);
  }

  const raw = normalized.calculate
    ? [{ result: data ?? null }]
    : rowsSchema.parse(data);
  const truncated = !normalized.calculate && raw.length > normalized.limit;
  const rows = raw
    .slice(0, normalized.limit)
    .map(row => shapeRow(row, normalized.columns, ctx.amounts.toMajor));

  return {
    rows,
    columns: normalized.columns,
    truncated,
    limit: normalized.limit,
  };
}
