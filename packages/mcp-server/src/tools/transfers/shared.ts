import { z } from 'zod';

import type { AmountConverter } from '#actual/amounts';
import { REASON_TEXT } from '#analysis/transfers';
import type { MatchReason, TransferCandidate } from '#analysis/transfers';

export const reasonSchema = z.enum([
  'several_possible_matches',
  'dates_far_apart',
  'category_would_be_cleared',
  'counterpart_already_exists',
]);

/** One side of a transfer as shown to the model. */
export const sideSchema = z.object({
  id: z.string(),
  date: z.string().describe('YYYY-MM-DD.'),
  amount: z.number().describe('Major units, signed: money out is negative.'),
  account: z.string().nullable(),
  off_budget: z
    .boolean()
    .describe('True when the account is a tracking (off-budget) account.'),
  payee: z.string().nullable(),
  category: z.string().nullable(),
});

export type Side = z.output<typeof sideSchema>;

export function toSide(
  money: AmountConverter,
  candidate: TransferCandidate,
): Side {
  return {
    id: candidate.id,
    date: candidate.date,
    amount: money.toMajor(candidate.amount),
    account: candidate.account,
    off_budget: candidate.account_off_budget,
    payee: candidate.payee,
    category: candidate.category,
  };
}

/** One side on one line, for the text a client shows the model. */
export function describeSide(money: AmountConverter, side: Side): string {
  return `${side.date} ${money.format(side.amount)} ${side.account ?? '(no account)'}${side.off_budget ? ' (off budget)' : ''} "${side.payee ?? '(no payee)'}"${side.category ? ` [${side.category}]` : ''} [id: ${side.id}]`;
}

export function describeReasons(reasons: MatchReason[]): string {
  return reasons.map(reason => REASON_TEXT[reason]).join('; ');
}
