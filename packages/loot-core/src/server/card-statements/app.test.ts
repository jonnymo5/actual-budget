import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { createSchedule, app as schedulesApp } from '#server/schedules/app';
import { loadRules } from '#server/transactions/transaction-rules';
import { q } from '#shared/query';
import type { ScheduleEntity } from '#types/models';

import {
  deleteStatement,
  listStatements,
  reconcileStatements,
  recordStatement,
} from './app';

// Tests run on 2017-01-01 (see currentDay in shared/months).
// Defined in src/mocks/setup.ts
const stepForwardInTime = (
  globalThis as unknown as { stepForwardInTime: () => void }
).stepForwardInTime;

let checkingId: string;
let cardId: string;
let cardPayee: string;
let regularId: string;

async function schedule(id: string): Promise<ScheduleEntity> {
  const { data } = await aqlQuery(q('schedules').filter({ id }).select('*'));
  return (data as ScheduleEntity[])[0];
}

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
  schedulesApp.startServices();

  checkingId = await db.insertAccount({ name: 'Checking', offbudget: 0 });
  cardId = await db.insertAccount({ name: 'Example Card', offbudget: 0 });
  cardPayee = await db.insertPayee({ name: '', transfer_acct: cardId });
  // The card's regular payment: a range, on the 5th of every month.
  regularId = await createSchedule({
    schedule: { name: 'Example Card payment' },
    conditions: [
      { op: 'is', field: 'payee', value: cardPayee },
      { op: 'is', field: 'account', value: checkingId },
      {
        op: 'isbetween',
        field: 'amount',
        value: { num1: -150000, num2: -90000 },
      },
      {
        op: 'isapprox',
        field: 'date',
        value: { start: '2017-01-05', frequency: 'monthly' },
      },
    ],
  });
  // The view picks the newer of the base/local next dates by timestamp.
  stepForwardInTime();
});

afterEach(async () => {
  await schedulesApp.stopServices();
});

describe('recordStatement', () => {
  it('schedules the exact payment and moves the regular one past it', async () => {
    expect((await schedule(regularId)).next_date).toBe('2017-01-05');

    const result = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 123456,
      closing_date: '2016-12-09',
      minimum_due: 4000,
    });

    expect(result).toMatchObject({
      created: true,
      payFrom: checkingId,
      paymentAmount: 123456,
      skippedSchedule: regularId,
      regularConflict: null,
      paid: false,
    });
    const payment = await schedule(result.scheduleId as string);
    expect(payment.name).toBe('Card · Example Card · 2017-01-05');
    expect(payment.posts_transaction).toBe(false);
    expect(payment._account).toBe(checkingId);
    expect(payment._payee).toBe(cardPayee);
    expect(payment._amount).toBe(-123456);
    expect(payment.next_date).toBe('2017-01-05');
    expect(payment._card_statement).toBe(result.statementId);
    expect((await schedule(regularId)).next_date).toBe('2017-02-05');

    const [statement] = await listStatements();
    expect(statement).toMatchObject({
      account: cardId,
      pay_from: checkingId,
      closing_date: '2016-12-09',
      statement_balance: 123456,
      minimum_due: 4000,
      due_date: '2017-01-05',
      payment_amount: null,
      schedule: result.scheduleId,
      skipped_schedule: regularId,
    });
  });

  it('updates a statement recorded again instead of skipping twice', async () => {
    const first = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 123456,
    });
    stepForwardInTime();
    const again = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 99900,
    });

    expect(again.created).toBe(false);
    expect(again.statementId).toBe(first.statementId);
    expect(again.scheduleId).toBe(first.scheduleId);
    expect(again.skippedSchedule).toBeNull();
    expect((await schedule(again.scheduleId as string))._amount).toBe(-99900);
    expect((await schedule(regularId)).next_date).toBe('2017-02-05');
    expect(await listStatements()).toHaveLength(1);
  });

  it('schedules a fixed payment instead of the balance', async () => {
    const result = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 800000,
      payment_amount: 60000,
    });
    expect(result.paymentAmount).toBe(60000);
    expect((await schedule(result.scheduleId as string))._amount).toBe(-60000);
  });

  it('skips the regular payment but schedules nothing when nothing is owed', async () => {
    const result = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 0,
    });
    expect(result.scheduleId).toBeNull();
    expect(result.skippedSchedule).toBe(regularId);
    expect((await schedule(regularId)).next_date).toBe('2017-02-05');
  });

  it('reports a regular payment due before the statement instead of skipping it', async () => {
    const result = await recordStatement({
      account: cardId,
      due_date: '2017-02-05',
      statement_balance: 50000,
    });
    expect(result.skippedSchedule).toBeNull();
    expect(result.regularConflict).toEqual({
      scheduleId: regularId,
      nextDate: '2017-01-05',
    });
    expect((await schedule(regularId)).next_date).toBe('2017-01-05');
  });

  it('needs the paying account when the card has no regular payment', async () => {
    const otherCard = await db.insertAccount({ name: 'Other Card' });
    await db.insertPayee({ name: '', transfer_acct: otherCard });
    await expect(
      recordStatement({
        account: otherCard,
        due_date: '2017-01-05',
        statement_balance: 1000,
      }),
    ).rejects.toThrow(/which account pays/);

    const result = await recordStatement({
      account: otherCard,
      due_date: '2017-01-05',
      statement_balance: 1000,
      pay_from: checkingId,
    });
    expect(result.payFrom).toBe(checkingId);
    expect(result.skippedSchedule).toBeNull();
  });

  it('rejects bad input', async () => {
    await expect(
      recordStatement({
        account: cardId,
        due_date: '01/05/2017',
        statement_balance: 1000,
      }),
    ).rejects.toThrow(/due date/);
    await expect(
      recordStatement({
        account: cardId,
        due_date: '2017-01-05',
        statement_balance: -5,
      }),
    ).rejects.toThrow(/statement balance/);
  });
});

describe('reconcileStatements', () => {
  it('closes a statement once its payment is in, whatever it is linked to', async () => {
    const result = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 123456,
    });
    await db.insertTransaction({
      account: checkingId,
      payee: cardPayee,
      amount: -123456,
      date: '2017-01-04',
      schedule: regularId,
    });

    expect(await reconcileStatements()).toEqual({
      paid: [result.statementId],
    });
    expect((await schedule(result.scheduleId as string)).completed).toBe(true);
    expect(await reconcileStatements()).toEqual({ paid: [] });
  });

  it('ignores payments outside the due date window', async () => {
    const result = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 123456,
    });
    await db.insertTransaction({
      account: checkingId,
      payee: cardPayee,
      amount: -123456,
      date: '2016-12-06',
    });

    expect(await reconcileStatements()).toEqual({ paid: [] });
    expect((await schedule(result.scheduleId as string)).completed).toBe(false);
  });

  it('records an old statement that was already paid as paid', async () => {
    await db.insertTransaction({
      account: checkingId,
      payee: cardPayee,
      amount: -50000,
      date: '2016-12-05',
    });
    const result = await recordStatement({
      account: cardId,
      due_date: '2016-12-05',
      statement_balance: 50000,
    });
    expect(result.paid).toBe(true);
    // The regular payment is a month later, so it is left alone.
    expect(result.skippedSchedule).toBeNull();
    expect(result.regularConflict).toBeNull();
  });
});

describe('deleteStatement', () => {
  it('removes the payment and puts the regular payment back', async () => {
    const result = await recordStatement({
      account: cardId,
      due_date: '2017-01-05',
      statement_balance: 123456,
    });
    stepForwardInTime();
    // Putting the regular payment back works its next date out from the
    // system clock, so pin it to the test date.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2017, 0, 1, 12) });
    try {
      await deleteStatement({ id: result.statementId });
    } finally {
      vi.useRealTimers();
    }

    expect(await listStatements()).toEqual([]);
    expect(await schedule(result.scheduleId as string)).toBeUndefined();
    expect((await schedule(regularId)).next_date).toBe('2017-01-05');
  });
});
