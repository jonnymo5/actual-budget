import { z } from 'zod';

import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import { succeed } from '#testing/tools';

let budget: TestBudget;
let connection: Awaited<ReturnType<typeof connectTestClient>>;

// loot-core decides which dates are ahead with the real clock.
function fifthOfMonthFromNow(offset: number): string {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 5);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-05`;
}
const DUE = fifthOfMonthFromNow(1);
const AFTER = fifthOfMonthFromNow(2);

const recordSchema = z.object({
  recorded_count: z.number(),
  results: z.array(
    z.object({
      account: z.string(),
      status: z.string(),
      pay_from: z.string().nullable(),
      payment_amount: z.number().nullable(),
      regular_schedule: z
        .object({
          name: z.string().nullable(),
          next_date: z.string(),
          skipped: z.boolean(),
        })
        .nullable(),
      paid: z.boolean().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

const listSchema = z.object({
  statements: z.array(
    z.object({
      id: z.string(),
      account: z.string(),
      closing_date: z.string().nullable(),
      due_date: z.string(),
      statement_balance: z.number(),
      minimum_due: z.number().nullable(),
      payment_amount: z.number(),
      pay_from: z.string(),
      status: z.string(),
    }),
  ),
});

const schedulesSchema = z.object({
  schedules: z.array(
    z.object({
      name: z.string().nullable(),
      next_date: z.string().nullable(),
      amount: z.number().nullable(),
    }),
  ),
});

beforeEach(async () => {
  budget = await createTestBudget();
  await budget.use(async ctx => {
    await ctx.api.createAccount({ name: 'Main Checking' });
    await ctx.api.createAccount({ name: 'Example Card' });
    await ctx.api.createAccount({ name: 'Other Card' });
  });
  connection = await connectTestClient({ session: budget.session });
  // The card's regular payment, a range on the 5th of every month.
  await succeed(
    connection,
    'create_schedules',
    {
      schedules: [
        {
          name: 'Example Card payment',
          account: 'Main Checking',
          payee: 'Example Card',
          amount: -1500,
          amount_upper: -900,
          amount_match: 'between',
          start_date: DUE,
          frequency: 'monthly',
        },
      ],
      dry_run: false,
    },
    z.object({}),
  );
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

async function schedules() {
  const { data } = await succeed(
    connection,
    'get_schedules',
    {},
    schedulesSchema,
  );
  return data.schedules;
}

describe('record_card_statement', () => {
  it('previews without recording anything', async () => {
    const { data, text } = await succeed(
      connection,
      'record_card_statement',
      {
        statements: [
          {
            account: 'Example Card',
            due_date: DUE,
            statement_balance: 1234.56,
          },
        ],
      },
      recordSchema,
    );
    expect(data.recorded_count).toBe(0);
    expect(data.results[0]).toMatchObject({
      status: 'ready',
      pay_from: 'Main Checking',
      payment_amount: 1234.56,
      regular_schedule: {
        name: 'Example Card payment',
        next_date: DUE,
        skipped: true,
      },
    });
    expect(text).toMatch(/Would record 1 of 1/);

    const listed = await succeed(
      connection,
      'get_card_statements',
      {},
      listSchema,
    );
    expect(listed.data.statements).toEqual([]);
  });

  it('records the payment and moves the regular payment past it', async () => {
    const { data } = await succeed(
      connection,
      'record_card_statement',
      {
        statements: [
          {
            account: 'Example Card',
            due_date: DUE,
            statement_balance: 1234.56,
            minimum_due: 40,
          },
        ],
        dry_run: false,
      },
      recordSchema,
    );
    expect(data.recorded_count).toBe(1);
    expect(data.results[0]).toMatchObject({ status: 'recorded', paid: false });

    const all = await schedules();
    expect(all).toContainEqual(
      expect.objectContaining({
        name: `Card · Example Card · ${DUE}`,
        next_date: DUE,
        amount: -1234.56,
      }),
    );
    expect(all).toContainEqual(
      expect.objectContaining({
        name: 'Example Card payment',
        next_date: AFTER,
      }),
    );

    const listed = await succeed(
      connection,
      'get_card_statements',
      { account: 'Example Card' },
      listSchema,
    );
    expect(listed.data.statements).toEqual([
      {
        id: expect.any(String),
        account: 'Example Card',
        closing_date: null,
        due_date: DUE,
        statement_balance: 1234.56,
        minimum_due: 40,
        payment_amount: 1234.56,
        pay_from: 'Main Checking',
        status: 'upcoming',
      },
    ]);
  });

  it('skips a card it cannot find a paying account for', async () => {
    const { data } = await succeed(
      connection,
      'record_card_statement',
      {
        statements: [
          { account: 'Other Card', due_date: DUE, statement_balance: 10 },
          {
            account: 'Other Card',
            due_date: DUE,
            statement_balance: 10,
            pay_from: 'Main Checking',
          },
        ],
        dry_run: false,
      },
      recordSchema,
    );
    expect(data.results.map(result => result.status)).toEqual([
      'skipped',
      'recorded',
    ]);
    expect(data.results[0].reason).toMatch(/which account pays/);
  });
});
