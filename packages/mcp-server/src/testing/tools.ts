import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { queryRows } from '#actual/query';
import type { ActualContext } from '#actual/session';

import type { connectTestClient } from './client';
import type { TestBudget } from './harness';

export type ToolConnection = Awaited<ReturnType<typeof connectTestClient>>;

/** Calls a tool that should succeed and parses its structured result. */
export async function succeed<Schema extends z.ZodType>(
  connection: ToolConnection,
  name: string,
  args: Record<string, unknown>,
  schema: Schema,
) {
  const { result, text, data } = await connection.call(name, args);
  expect(result.isError, text).not.toBe(true);
  return { text, data: schema.parse(data) };
}

/** Calls a tool that should be refused and returns the message the model would see. */
export async function fail(
  connection: ToolConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { result, text } = await connection.call(name, args);
  expect(result.isError, text).toBe(true);
  return text;
}

/** The ids of the transactions matching an ActualQL filter, split parents included. */
export async function findTransactionIds(
  budget: TestBudget,
  filter: Record<string, unknown>,
): Promise<string[]> {
  const rows = await budget.use(ctx =>
    queryRows(
      ctx,
      ctx.api
        .q('transactions')
        .filter(filter)
        .select(['id'])
        .orderBy(['date', 'id'])
        .options({ splits: 'all' }),
      z.object({ id: z.string() }),
    ),
  );
  return rows.map(row => row.id);
}

type PlainTransaction = {
  date: string;
  /** Major units, signed. */
  amount: number;
  /** A payee id. */
  payee?: string;
  /** A category id. */
  category?: string;
  notes?: string;
};

/**
 * Adds transactions exactly as given. The API's `addTransactions` runs the
 * budget's rules on each one (slowly, too), which would quietly categorize the
 * rows a test means to leave alone.
 */
export async function addTransactionsWithoutRules(
  ctx: ActualContext,
  account: string,
  rows: PlainTransaction[],
): Promise<void> {
  await ctx.lootCore.send('transactions-batch-update', {
    added: rows.map(row => ({
      id: randomUUID(),
      account,
      date: row.date,
      amount: ctx.amounts.toMinor(row.amount),
      payee: row.payee,
      category: row.category,
      notes: row.notes,
      cleared: true,
    })),
  });
}

/**
 * A rule on the payee's name as typed at import. Actual's own rule screen can
 * make one, but the transactions it matches cannot be looked up afterwards, so
 * it is how tests reach the "cannot be previewed" paths. The types do not list
 * `payee_name`, hence the unchecked parse.
 */
export async function createImportOnlyRule(
  ctx: ActualContext,
  category: string,
): Promise<{ id: string }> {
  const rule = z
    .custom<Parameters<ActualContext['api']['createRule']>[0]>()
    .parse({
      stage: 'default',
      conditionsOp: 'and',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Costco' }],
      actions: [{ op: 'set', field: 'category', value: category }],
    });
  return ctx.api.createRule(rule);
}
