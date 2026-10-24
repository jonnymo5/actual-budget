import { z } from 'zod';

import { QUERYABLE_TABLES } from '#actual/aql-schema';
import { runStructuredQuery } from '#actual/structured-query';
import { defineTool } from '#tools/registry';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const entry = z.union([z.string(), z.record(z.string(), z.unknown())]);

const DESCRIPTION = `Escape hatch for questions no other tool answers: run a read-only structured query over one table. Try the dedicated tools first (get_transactions, get_budget_month, ...).

Tables: ${QUERYABLE_TABLES.join(', ')}. Follow references with a dot: payee.name, account.name, category.name, category.group.name. Amounts are in major currency units (e.g. dollars, not cents) in both filters and results, and spending is negative. Dates are YYYY-MM-DD. Text starting with $ means "the value of that field".

- filter: conditions, e.g. {"date": {"$gte": "2026-01-01"}, "category.name": "Groceries", "amount": {"$lt": -50}}. A bare value means equals. Operators: $eq $ne $lt $lte $gt $gte $like (% is a wildcard, ignores case) $notlike $regexp $oneof (a list). Combine with {"$or": [{...}, {...}]} or {"$and": [...]}. To compare part of a date: {"date": {"$transform": "$month", "$eq": "2026-09"}}.
- select: field names or named expressions, e.g. ["date", "payee.name", {"total": {"$sum": "$amount"}}]. Functions: $sum $count $abs $neg $lower $substr $day $month $year. Omit select for sensible default columns.
- group_by: field names or functions, e.g. ["payee.name"] or [{"$month": "$date"}]. Select an aggregate to get one row per group.
- order_by: ["date"], [{"date": "desc"}] or [{"$sum": "$amount", "$dir": "asc"}].
- calculate: a single aggregate such as {"$sum": "$amount"}, returned as one row {"result": ...}. Do not combine it with select, group_by or order_by.

Example, grocery spending by month: {"table": "transactions", "filter": {"category.name": "Groceries"}, "select": [{"month": {"$month": "$date"}}, {"total": {"$sum": "$amount"}}], "group_by": [{"$month": "$date"}], "order_by": [{"$month": "$date"}]}.

Results are capped at limit rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); narrow the query or aggregate rather than raising it.`;

export const runQuery = defineTool({
  name: 'run_query',
  title: 'Run a query',
  description: DESCRIPTION,
  kind: 'read',
  input: {
    table: z.enum(QUERYABLE_TABLES).describe('The table to query.'),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Conditions rows must meet; see the tool description.'),
    select: z
      .array(entry)
      .optional()
      .describe('Columns to return: field names or {"name": expression}.'),
    group_by: z
      .array(entry)
      .optional()
      .describe('Fields or functions to group by.'),
    order_by: z.array(entry).optional().describe('How to sort the rows.'),
    calculate: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'One aggregate over all matching rows, e.g. {"$sum": "$amount"}.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `Most rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      ),
  },
  output: {
    columns: z.array(z.string()).describe('Column names, in order.'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Money columns are in major units; dates are YYYY-MM-DD.'),
    row_count: z.number(),
    limit: z.number(),
    truncated: z
      .boolean()
      .describe('True when more rows matched than were returned.'),
  },
  async handler(input, ctx) {
    const result = await runStructuredQuery(ctx, input);

    const { format } = ctx.amounts;
    const cell = (value: unknown, money: boolean): string => {
      if (value === null || value === undefined) return '';
      if (money && typeof value === 'number') return format(value);
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    };
    const header = `${result.rows.length} row(s)${
      result.truncated
        ? `; more rows matched than the limit of ${result.limit}, so narrow the query or aggregate`
        : ''
    }`;
    const lines = [
      result.columns.map(column => column.key).join(' | '),
      ...result.rows.map(row =>
        result.columns
          .map(column => cell(row[column.key], column.money))
          .join(' | '),
      ),
    ];

    return {
      data: {
        columns: result.columns.map(column => column.key),
        rows: result.rows,
        row_count: result.rows.length,
        limit: result.limit,
        truncated: result.truncated,
      },
      text:
        result.rows.length === 0 ? 'No rows.' : [header, ...lines].join('\n'),
    };
  },
});
