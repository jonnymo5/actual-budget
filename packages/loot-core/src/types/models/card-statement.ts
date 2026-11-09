import type { AccountEntity } from './account';
import type { ScheduleEntity } from './schedule';

/**
 * A credit card statement as printed on the bank's statement: what it closed
 * at and when it is due. Each one owns the one-off schedule for its payment,
 * so the payment shows in projections at its real amount.
 */
export type CardStatementEntity = {
  id: string;
  /** The card account the statement belongs to. */
  account: AccountEntity['id'];
  /** The account the payment leaves from. */
  pay_from: AccountEntity['id'];
  /** YYYY-MM-DD */
  closing_date: string | null;
  /** Integer cents owed on the statement, positive. */
  statement_balance: number;
  /** Integer cents, positive. */
  minimum_due: number | null;
  /** YYYY-MM-DD */
  due_date: string;
  /**
   * Integer cents that will be paid, positive, when it is not the statement
   * balance (a fixed or minimum payment).
   */
  payment_amount: number | null;
  /** The one-off schedule for the payment; null when nothing is owed. */
  schedule: ScheduleEntity['id'] | null;
  /** The card's recurring payment schedule whose occurrence this replaced. */
  skipped_schedule: ScheduleEntity['id'] | null;
  tombstone: boolean;
};
