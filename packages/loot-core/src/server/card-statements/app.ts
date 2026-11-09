import { v4 as uuidv4 } from 'uuid';

import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { toDateRepr } from '#server/models';
import { mutator, runMutator } from '#server/mutators';
import {
  createSchedule,
  deleteSchedule,
  setNextDate,
  skipNextDate,
  updateSchedule,
} from '#server/schedules/app';
import { undoable } from '#server/undo';
import { addDays, currentDay, subDays } from '#shared/months';
import { q } from '#shared/query';
import type {
  CardStatementEntity,
  RuleConditionEntity,
  ScheduleEntity,
} from '#types/models';

/** How far a card's regular payment may sit from a statement's due date and
 * still be the occurrence the statement replaces. */
export const REGULAR_PAYMENT_WINDOW_DAYS = 10;
/** A payment this many days before the due date still pays the statement. */
export const PAYMENT_WINDOW_BEFORE_DAYS = 7;
/** A payment this many days after the due date still pays the statement. */
export const PAYMENT_WINDOW_AFTER_DAYS = 10;

export const CARD_SCHEDULE_PREFIX = 'Card · ';

export type CardStatementInput = {
  /** The card account. */
  account: string;
  /** YYYY-MM-DD */
  due_date: string;
  /** Integer cents owed, zero or more. */
  statement_balance: number;
  /** YYYY-MM-DD */
  closing_date?: string | null;
  /** Integer cents. */
  minimum_due?: number | null;
  /** Integer cents that will be paid, when not the statement balance. */
  payment_amount?: number | null;
  /** The account the payment leaves from. Defaults to the account the card's
   * regular payment schedule pays from. */
  pay_from?: string | null;
};

export type CardStatementRecordResult = {
  statementId: string;
  /** False when a statement with this due date was already recorded. */
  created: boolean;
  scheduleId: string | null;
  payFrom: string;
  /** Integer cents. */
  paymentAmount: number;
  /** The regular payment schedule whose next payment this call skipped. */
  skippedSchedule: string | null;
  /**
   * The card's regular payment schedule could not be skipped because its next
   * payment is earlier than this statement's; it will also count near the due
   * date until that earlier payment is in.
   */
  regularConflict: { scheduleId: string; nextDate: string } | null;
  /** A payment matching the statement is already in the budget. */
  paid: boolean;
};

export type CardStatementPlan = {
  account: { id: string; name: string };
  /** The statement already recorded for this card and due date, if any. */
  existing: CardStatementEntity | null;
  payFrom: string;
  /** Integer cents. */
  paymentAmount: number;
  /** The card's own recurring payment schedule, if it has one. */
  regular: { id: string; name: string | null; nextDate: string } | null;
  /** Whether recording moves the regular payment past this statement. */
  skipsRegular: boolean;
  regularConflict: CardStatementRecordResult['regularConflict'];
};

export type CardStatementsHandlers = {
  'card-statement/plan': typeof planStatement;
  'card-statement/record': typeof recordStatement;
  'card-statement/delete': typeof deleteStatement;
  'card-statement/list': typeof listStatements;
  'card-statement/reconcile': typeof reconcileStatements;
};

export const app = createApp<CardStatementsHandlers>();
app.method('card-statement/plan', planStatement);
app.method('card-statement/record', mutator(undoable(recordStatement)));
app.method('card-statement/delete', mutator(undoable(deleteStatement)));
app.method('card-statement/list', listStatements);
app.method('card-statement/reconcile', mutator(reconcileStatements));

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type ScheduleRow = Pick<
  ScheduleEntity,
  | 'id'
  | 'name'
  | 'next_date'
  | 'completed'
  | '_payee'
  | '_account'
  | '_date'
  | '_card_statement'
  | '_rsu_vest_event'
>;

function isRecurring(schedule: Pick<ScheduleEntity, '_date'>): boolean {
  return (
    typeof schedule._date === 'object' &&
    schedule._date !== null &&
    'frequency' in schedule._date
  );
}

function dayDistance(a: string, b: string): number {
  return Math.abs(
    (new Date(`${a}T00:00:00Z`).getTime() -
      new Date(`${b}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

async function transferPayeeFor(account: string): Promise<string> {
  const payee = await db.first<Pick<db.DbPayee, 'id'>>(
    'SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0',
    [account],
  );
  if (!payee) {
    throw new Error('Card account not found');
  }
  return payee.id;
}

async function getScheduleRow(id: string | null): Promise<ScheduleRow | null> {
  if (!id) {
    return null;
  }
  const { data } = await aqlQuery(q('schedules').filter({ id }).select('*'));
  return (data as ScheduleRow[])[0] ?? null;
}

/**
 * The card's own recurring payment schedule (not one a statement or an RSU
 * grant owns), the one closest to `dueDate` when there are several.
 */
async function findRegularSchedule(
  transferPayee: string,
  dueDate: string,
): Promise<ScheduleRow | null> {
  const { data } = await aqlQuery(
    q('schedules').filter({ completed: false }).select('*'),
  );
  const candidates = (data as ScheduleRow[]).filter(
    schedule =>
      schedule._payee === transferPayee &&
      !schedule._card_statement &&
      !schedule._rsu_vest_event &&
      isRecurring(schedule),
  );
  candidates.sort(
    (a, b) =>
      dayDistance(a.next_date, dueDate) - dayDistance(b.next_date, dueDate),
  );
  return candidates[0] ?? null;
}

async function uniqueName(
  accountName: string,
  dueDate: string,
  ownScheduleId: string | null,
): Promise<string> {
  const base = `${CARD_SCHEDULE_PREFIX}${accountName.trim()} · ${dueDate}`;
  for (let index = 0; ; index++) {
    const name = index === 0 ? base : `${base} (${index + 1})`;
    const taken = await db.first<Pick<db.DbSchedule, 'id'>>(
      'SELECT id FROM schedules WHERE tombstone = 0 AND name = ?',
      [name],
    );
    if (!taken || taken.id === ownScheduleId) {
      return name;
    }
  }
}

function paymentConditions({
  transferPayee,
  payFrom,
  dueDate,
  amount,
}: {
  transferPayee: string;
  payFrom: string;
  dueDate: string;
  amount: number;
}): RuleConditionEntity[] {
  return [
    { op: 'is', field: 'payee', value: transferPayee },
    { op: 'is', field: 'account', value: payFrom },
    { op: 'isapprox', field: 'date', value: dueDate },
    { op: 'isapprox', field: 'amount', value: -amount },
  ];
}

function validate(input: CardStatementInput) {
  if (!input.account) {
    throw new Error('A card account is required');
  }
  if (!ISO_DATE_RE.test(input.due_date ?? '')) {
    throw new Error('The due date is not valid');
  }
  if (input.closing_date != null && !ISO_DATE_RE.test(input.closing_date)) {
    throw new Error('The closing date is not valid');
  }
  for (const [label, value] of [
    ['statement balance', input.statement_balance],
    ['minimum due', input.minimum_due],
    ['payment amount', input.payment_amount],
  ] as const) {
    if (value != null && !(Number.isInteger(value) && value >= 0)) {
      throw new Error(`The ${label} must be zero or more`);
    }
  }
}

async function getStatement(
  account: string,
  dueDate: string,
): Promise<CardStatementEntity | null> {
  const { data } = await aqlQuery(
    q('card_statements').filter({ account, due_date: dueDate }).select('*'),
  );
  return (data as CardStatementEntity[])[0] ?? null;
}

/**
 * Work out what recording a statement would do, without changing anything:
 * which account pays, how much, and what happens to the card's regular
 * payment schedule.
 */
export async function planStatement(
  input: CardStatementInput,
): Promise<CardStatementPlan> {
  validate(input);
  const account = await db.first<Pick<db.DbAccount, 'id' | 'name'>>(
    'SELECT id, name FROM accounts WHERE id = ? AND tombstone = 0',
    [input.account],
  );
  if (!account) {
    throw new Error('Card account not found');
  }
  const transferPayee = await transferPayeeFor(account.id);
  const existing = await getStatement(account.id, input.due_date);
  const regular = await findRegularSchedule(transferPayee, input.due_date);

  const payFrom = input.pay_from ?? existing?.pay_from ?? regular?._account;
  if (!payFrom) {
    throw new Error(
      'Say which account pays this card: it has no regular payment schedule to take it from',
    );
  }
  if (payFrom === account.id) {
    throw new Error('A card cannot pay itself');
  }

  let skipsRegular = false;
  let regularConflict: CardStatementPlan['regularConflict'] = null;
  if (!existing?.skipped_schedule && regular) {
    if (
      dayDistance(regular.next_date, input.due_date) <=
      REGULAR_PAYMENT_WINDOW_DAYS
    ) {
      skipsRegular = true;
    } else if (regular.next_date < input.due_date) {
      regularConflict = { scheduleId: regular.id, nextDate: regular.next_date };
    }
  }

  return {
    account: { id: account.id, name: account.name },
    existing,
    payFrom,
    paymentAmount: input.payment_amount ?? input.statement_balance,
    regular: regular
      ? {
          id: regular.id,
          name: regular.name ?? null,
          nextDate: regular.next_date,
        }
      : null,
    skipsRegular,
    regularConflict,
  };
}

/**
 * Record a card statement and make the card's next payment match it: a
 * one-off schedule for the amount that will be paid on the due date, and the
 * card's regular recurring payment moved past that payment so it is not
 * counted twice. Recording the same card and due date again updates it.
 */
export async function recordStatement(
  input: CardStatementInput,
): Promise<CardStatementRecordResult> {
  const plan = await planStatement(input);
  const { account, existing, payFrom, paymentAmount } = plan;
  const transferPayee = await transferPayeeFor(account.id);

  const id = existing?.id ?? uuidv4();
  const row = {
    account: account.id,
    pay_from: payFrom,
    closing_date: input.closing_date ?? null,
    statement_balance: input.statement_balance,
    minimum_due: input.minimum_due ?? null,
    due_date: input.due_date,
    payment_amount: input.payment_amount ?? null,
  };
  if (existing) {
    await db.updateWithSchema('card_statements', { id, ...row });
  } else {
    await db.insertWithSchema('card_statements', {
      id,
      ...row,
      schedule: null,
      skipped_schedule: null,
      tombstone: false,
    });
  }

  // The payment schedule.
  let scheduleId: string | null = null;
  const current = await getScheduleRow(existing?.schedule ?? null);
  if (paymentAmount > 0) {
    const conditions = paymentConditions({
      transferPayee,
      payFrom,
      dueDate: input.due_date,
      amount: paymentAmount,
    });
    const name = await uniqueName(
      account.name,
      input.due_date,
      current?.id ?? null,
    );
    if (current && !current.completed) {
      await updateSchedule({ schedule: { id: current.id, name }, conditions });
      scheduleId = current.id;
    } else if (current) {
      scheduleId = current.id;
    } else {
      scheduleId = await createSchedule({
        schedule: { id: uuidv4(), name, posts_transaction: false },
        conditions,
      });
    }
  } else if (current && !current.completed) {
    await deleteSchedule({ id: current.id });
  }
  await db.updateWithSchema('card_statements', { id, schedule: scheduleId });

  // The regular payment this statement replaces.
  let skippedSchedule: string | null = null;
  if (plan.skipsRegular && plan.regular) {
    await skipNextDate({ id: plan.regular.id });
    skippedSchedule = plan.regular.id;
    await db.updateWithSchema('card_statements', {
      id,
      skipped_schedule: plan.regular.id,
    });
  }

  const reconciled = await reconcileStatements({ statementId: id });
  return {
    statementId: id,
    created: !existing,
    scheduleId,
    payFrom,
    paymentAmount,
    skippedSchedule,
    regularConflict: plan.regularConflict,
    paid: reconciled.paid.includes(id),
  };
}

/**
 * Remove a statement with its payment schedule, unless that was paid. When the
 * statement had moved the card's regular payment on and is not due yet, the
 * regular payment's next date is worked out again from today.
 */
export async function deleteStatement({
  id,
}: Pick<CardStatementEntity, 'id'>): Promise<void> {
  const { data } = await aqlQuery(
    q('card_statements').filter({ id }).select('*'),
  );
  const statement = (data as CardStatementEntity[])[0];
  if (!statement) {
    return;
  }
  const schedule = await getScheduleRow(statement.schedule);
  if (schedule && !schedule.completed) {
    await deleteSchedule({ id: schedule.id });
  }
  if (statement.skipped_schedule && statement.due_date >= currentDay()) {
    const regular = await getScheduleRow(statement.skipped_schedule);
    if (regular && !regular.completed) {
      await setNextDate({ id: regular.id });
    }
  }
  await db.delete_('card_statements', id);
}

export async function listStatements({
  account,
}: { account?: string } = {}): Promise<CardStatementEntity[]> {
  let query = q('card_statements').select('*');
  if (account) {
    query = query.filter({ account });
  }
  const { data } = await aqlQuery(query);
  return data as CardStatementEntity[];
}

/**
 * Mark each statement's payment schedule done once a payment from its paying
 * account to the card is in the budget near the due date, whichever schedule
 * Actual linked that payment to. Without this, a payment linked to the card's
 * regular schedule would leave the statement's schedule looking overdue.
 */
export async function reconcileStatements({
  statementId,
}: { statementId?: string } = {}): Promise<{ paid: string[] }> {
  const statements = statementId
    ? (
        await aqlQuery(
          q('card_statements').filter({ id: statementId }).select('*'),
        )
      ).data
    : await listStatements();
  const paid: string[] = [];
  for (const statement of statements as CardStatementEntity[]) {
    const schedule = await getScheduleRow(statement.schedule);
    if (!schedule || schedule.completed) {
      continue;
    }
    const transferPayee = await transferPayeeFor(statement.account);
    const { data: payments } = await aqlQuery(
      q('transactions')
        .filter({
          account: statement.pay_from,
          payee: transferPayee,
          amount: { $lt: 0 },
          date: {
            $gte: subDays(statement.due_date, PAYMENT_WINDOW_BEFORE_DAYS),
            $lte: addDays(statement.due_date, PAYMENT_WINDOW_AFTER_DAYS),
          },
        })
        .select(['id']),
    );
    if ((payments as unknown[]).length > 0) {
      await updateSchedule({ schedule: { id: schedule.id, completed: true } });
      paid.push(statement.id);
    }
  }
  return { paid };
}

// After a sync, close the statements whose payment has come in.
app.events.on('sync', ({ type }) => {
  if (type !== 'success' || !db.getDatabase()) {
    return;
  }
  const open = db.firstSync<{ id: string }>(
    `SELECT cs.id FROM card_statements cs
     JOIN schedules s ON s.id = cs.schedule
     WHERE cs.tombstone = 0 AND s.tombstone = 0 AND s.completed = 0
       AND cs.due_date <= ?
     LIMIT 1`,
    [toDateRepr(addDays(currentDay(), PAYMENT_WINDOW_BEFORE_DAYS))],
  );
  if (!open) {
    return;
  }
  void runMutator(async () => {
    if (!db.getDatabase()) {
      return;
    }
    try {
      await reconcileStatements();
    } catch (error) {
      logger.warn('Card statement reconcile failed', error);
    }
  });
});
