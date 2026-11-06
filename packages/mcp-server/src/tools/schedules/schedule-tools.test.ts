import { z } from 'zod';

import { connectTestClient } from '#testing/client';
import { createTestBudget } from '#testing/harness';
import type { TestBudget } from '#testing/harness';
import { fail, succeed } from '#testing/tools';

// Every test gets a budget of its own, because they all add schedules. Main
// and Visa are on-budget accounts, so Visa has a transfer payee. Start dates
// are far in the future so each schedule's dates are the same whatever day the
// tests run (2030-01-01 is a Tuesday).
let budget: TestBudget;
let connection: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  budget = await createTestBudget();
  await budget.use(async ({ api }) => {
    await api.createAccount({ name: 'Main' });
    await api.createAccount({ name: 'Visa' });
    await api.createPayee({ name: 'Lender' });
    await api.createPayee({ name: 'Employer' });
  });
  connection = await connectTestClient({ session: budget.session });
});

afterEach(async () => {
  await connection.close();
  await budget.dispose();
});

const entrySchema = z.object({
  status: z.enum(['ready', 'skipped']),
  name: z.string(),
  account: z.string().nullable(),
  payee: z.string().nullable(),
  amount: z.number(),
  amount_upper: z.number().nullable(),
  amount_match: z.enum(['exact', 'approximate', 'between']),
  posts_transaction: z.boolean(),
  recurrence: z.string().nullable(),
  upcoming_dates: z.array(z.string()),
  skipped_reason: z.string().nullable(),
  created: z.boolean(),
  schedule_id: z.string().nullable(),
  next_date: z.string().nullable(),
});
const createSchema = z.object({
  requested: z.number(),
  ready_count: z.number(),
  skipped_count: z.number(),
  created_count: z.number(),
  schedules: z.array(entrySchema),
  warnings: z.array(z.string()),
  dry_run: z.boolean(),
});
const listedSchema = z.object({
  schedules: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      next_date: z.string().nullable(),
      posts_transaction: z.boolean(),
      payee: z.string().nullable(),
      account: z.string().nullable(),
      amount: z.number().nullable(),
      amount_upper: z.number().nullable(),
      amount_match: z.enum(['exact', 'approximate', 'between']).nullable(),
      recurrence: z.object({
        description: z.string(),
        frequency: z.enum(['once', 'daily', 'weekly', 'monthly', 'yearly']),
        interval: z.number(),
        start: z.string(),
        ends: z.string().nullable(),
      }),
    }),
  ),
});

const mortgage = {
  name: 'Mortgage',
  account: 'Main',
  payee: 'Lender',
  amount: -1850.25,
  start_date: '2030-01-01',
  frequency: 'monthly',
  weekend: 'after',
};

function create(schedules: Record<string, unknown>[], dryRun = false) {
  return succeed(
    connection,
    'create_schedules',
    { schedules, dry_run: dryRun },
    createSchema,
  );
}

async function listed() {
  const { data } = await succeed(connection, 'get_schedules', {}, listedSchema);
  return data.schedules;
}

describe('create_schedules', () => {
  it('previews by default and creates nothing', async () => {
    const { data, text } = await succeed(
      connection,
      'create_schedules',
      { schedules: [mortgage] },
      createSchema,
    );

    expect(data.dry_run).toBe(true);
    expect(data.created_count).toBe(0);
    expect(data.ready_count).toBe(1);
    expect(data.schedules[0]).toMatchObject({
      status: 'ready',
      created: false,
      schedule_id: null,
      account: 'Main',
      payee: 'Lender',
      amount: -1850.25,
      upcoming_dates: [
        '2030-01-01',
        '2030-02-01',
        '2030-03-01',
        '2030-04-01',
        '2030-05-01',
        '2030-06-03',
      ],
    });
    expect(text).toContain('DRY RUN');
    expect(await listed()).toEqual([]);
  });

  it('creates a monthly schedule that get_schedules then lists', async () => {
    const { data } = await create([mortgage]);

    expect(data.dry_run).toBe(false);
    expect(data.created_count).toBe(1);
    const [made] = data.schedules;
    expect(made.created).toBe(true);
    expect(made.schedule_id).toEqual(expect.any(String));

    const [found] = await listed();
    expect(found).toMatchObject({
      id: made.schedule_id,
      name: 'Mortgage',
      account: 'Main',
      payee: 'Lender',
      amount: -1850.25,
      amount_match: 'exact',
      posts_transaction: false,
      next_date: made.next_date,
      recurrence: { frequency: 'monthly', interval: 1, start: '2030-01-01' },
    });
    // Actual's own first date agrees with the one the preview showed.
    expect(made.next_date).toBe(made.upcoming_dates[0]);
  });

  it('puts several days of a month in one schedule and moves weekends', async () => {
    const { data } = await create(
      [
        {
          name: 'Paycheck',
          account: 'Main',
          payee: 'Employer',
          amount: 2500,
          start_date: '2030-01-01',
          frequency: 'monthly',
          days_of_month: [25, 10],
          weekend: 'before',
        },
      ],
      true,
    );

    // 2030-02-10 and 2030-03-10 are Sundays, so the paycheck comes the Friday
    // before.
    expect(data.schedules[0].upcoming_dates).toEqual([
      '2030-01-10',
      '2030-01-25',
      '2030-02-08',
      '2030-02-25',
      '2030-03-08',
      '2030-03-25',
    ]);
    expect(data.schedules[0].recurrence).toContain('day 10 and day 25');
  });

  it('pays a credit card through its transfer payee', async () => {
    await create([
      {
        name: 'Visa payment',
        account: 'Main',
        payee: 'Visa',
        amount: -2000,
        amount_match: 'approximate',
        start_date: '2030-01-05',
        frequency: 'monthly',
      },
    ]);

    const [found] = await listed();
    expect(found).toMatchObject({
      name: 'Visa payment',
      payee: 'Visa',
      amount: -2000,
      amount_match: 'approximate',
    });
  });

  it('keeps a range and lets Actual post the transaction', async () => {
    await create([
      {
        name: 'Electric',
        account: 'Main',
        payee: 'Lender',
        amount: -160,
        amount_upper: -90,
        amount_match: 'between',
        start_date: '2030-01-20',
        frequency: 'monthly',
        posts_transaction: true,
      },
    ]);

    const [found] = await listed();
    expect(found).toMatchObject({
      amount: -160,
      amount_upper: -90,
      amount_match: 'between',
      posts_transaction: true,
    });
  });

  it('makes one-off and ending schedules', async () => {
    const { data } = await create(
      [
        {
          name: 'Tax bill',
          account: 'Main',
          payee: 'Lender',
          amount: -500,
          start_date: '2030-06-01',
          frequency: 'once',
        },
        {
          name: 'Loan',
          account: 'Main',
          payee: 'Lender',
          amount: -100,
          start_date: '2030-01-07',
          frequency: 'weekly',
          interval: 2,
          end_after_occurrences: 3,
        },
      ],
      true,
    );

    const [tax, loan] = data.schedules;
    expect(tax.recurrence).toBe('once, on 2030-06-01');
    expect(tax.upcoming_dates).toEqual(['2030-06-01']);
    expect(loan.upcoming_dates).toEqual([
      '2030-01-07',
      '2030-01-21',
      '2030-02-04',
    ]);
    expect(loan.recurrence).toContain('ending after 3 occurrences');
  });

  it('skips what cannot be created and still creates the rest', async () => {
    await create([mortgage]);

    const { data } = await create([
      { ...mortgage, name: 'Mortgage' },
      { ...mortgage, name: 'Rent', account: 'Nowhere' },
      { ...mortgage, name: 'Zero', amount: 0 },
      { ...mortgage, name: 'No upper', amount_match: 'between' },
      { ...mortgage, name: 'Stray upper', amount_upper: -1 },
      { ...mortgage, name: 'Once', frequency: 'once', interval: 2 },
      {
        ...mortgage,
        name: 'Weekly days',
        frequency: 'weekly',
        days_of_month: [1],
      },
      {
        ...mortgage,
        name: 'Both ends',
        end_after_occurrences: 2,
        end_date: '2031-01-01',
      },
      { ...mortgage, name: 'Backwards', end_date: '2029-01-01' },
      { ...mortgage, name: 'Fine', start_date: '2030-02-01' },
      { ...mortgage, name: 'Fine' },
    ]);

    const reasons = data.schedules.map(entry => entry.skipped_reason ?? '');

    expect(data.created_count).toBe(1);
    expect(data.skipped_count).toBe(10);
    expect(data.schedules[9]).toMatchObject({ name: 'Fine', status: 'ready' });
    expect(reasons[0]).toMatch(/already a schedule named "Mortgage"/);
    expect(reasons[1]).toMatch(/unknown account "Nowhere".*Main/);
    expect(reasons[2]).toMatch(/cannot be 0/);
    expect(reasons[3]).toMatch(/needs amount_upper/);
    expect(reasons[4]).toMatch(/only for amount_match "between"/);
    expect(reasons[5]).toMatch(/only apply to a repeating schedule/);
    expect(reasons[6]).toMatch(/only applies to a monthly/);
    expect(reasons[7]).toMatch(/not both/);
    expect(reasons[8]).toMatch(/end_date is before start_date/);
    expect(reasons[10]).toMatch(/already a schedule named "Fine"/);

    // get_schedules lists the soonest first: Mortgage (2030-01-01), then Fine.
    expect((await listed()).map(schedule => schedule.name)).toEqual([
      'Mortgage',
      'Fine',
    ]);
  });

  it('warns about days that some months lack, past one-offs and likely duplicates', async () => {
    await create([mortgage]);

    const { data } = await create(
      [
        {
          ...mortgage,
          name: 'Month end',
          payee: 'Employer',
          days_of_month: [31],
        },
        {
          name: 'Old bill',
          account: 'Main',
          payee: 'Employer',
          amount: -10,
          start_date: '2020-01-01',
          frequency: 'once',
        },
        { ...mortgage, name: 'Mortgage again' },
      ],
      true,
    );

    expect(data.warnings).toHaveLength(3);
    expect(data.warnings.join('\n')).toMatch(/Use -1 for the last day/);
    expect(data.warnings.join('\n')).toMatch(/already past/);
    expect(data.warnings.join('\n')).toMatch(
      /looks like the existing schedule "Mortgage"/,
    );
  });

  it('feeds cash_flow_projection, which places each payment on its date', async () => {
    // The first of next month, so the schedule falls inside the projection
    // whatever day the tests run.
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const start = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`;
    await create([
      { ...mortgage, amount: -1000, start_date: start, weekend: 'none' },
    ]);

    const { data } = await succeed(
      connection,
      'cash_flow_projection',
      { months: 3, include_baseline: false },
      z.object({
        scheduled_event_count: z.number(),
        scheduled_events: z.array(
          z.object({
            date: z.string(),
            name: z.string().nullable(),
            account: z.string().nullable(),
            amount: z.number(),
            overdue: z.boolean(),
          }),
        ),
      }),
    );

    expect(data.scheduled_event_count).toBe(3);
    expect(data.scheduled_events[0]).toEqual({
      date: start,
      name: 'Mortgage',
      account: 'Main',
      amount: -1000,
      overdue: false,
    });
  });

  it('refuses a date that is not real', async () => {
    const message = await fail(connection, 'create_schedules', {
      schedules: [{ ...mortgage, start_date: '2030-02-31' }],
      dry_run: false,
    });
    expect(message).toMatch(/real calendar date/);
  });
});
