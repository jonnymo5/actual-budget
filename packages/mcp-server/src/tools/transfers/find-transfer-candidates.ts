import { z } from 'zod';

import { assertKnownAccount } from '#actual/transactions';
import { loadUnlinkedPool } from '#actual/transfers';
import {
  DEFAULT_WINDOW_DAYS,
  findTransferMatches,
  MAX_WINDOW_DAYS,
} from '#analysis/transfers';
import { toolError } from '#errors';
import { defineTool } from '#tools/registry';
import { isoDate } from '#tools/schemas';

import {
  describeReasons,
  describeSide,
  reasonSchema,
  sideSchema,
  toSide,
} from './shared';

const matchSchema = z.object({
  status: z
    .enum(['clear', 'needs_confirmation'])
    .describe(
      '"clear": nothing else fits and no category is lost, so it is safe to link. "needs_confirmation": ask the person first.',
    ),
  from: sideSchema.describe('The side where money left.'),
  to: sideSchema
    .nullable()
    .describe(
      'The side where money arrived. When several fit, the nearest by date; null when two are equally near.',
    ),
  alternatives: z
    .array(sideSchema)
    .describe('Every transaction that could be "to", when more than one fits.'),
  competing: z
    .array(sideSchema)
    .describe('Other outflows that fit "to" just as well as "from" does.'),
  days_apart: z.number().nullable(),
  reasons: z
    .array(reasonSchema)
    .describe('Why a pair needs confirmation; empty for a clear one.'),
});

export const findTransferCandidates = defineTool({
  name: 'find_transfer_candidates',
  title: 'Find unlinked transfers',
  description:
    'Finds transactions that look like the two sides of one transfer between your own accounts but are not linked as a transfer, such as a card payment that left checking on one day and arrived on the card the next. Until they are linked, Actual counts the card-side payment as income and the checking-side payment as spending. A pair is two transactions in different accounts (tracking accounts included) with exactly opposite amounts, within window_days of each other. Amounts are in major currency units (e.g. dollars, not cents) and signed; dates are YYYY-MM-DD, both ends inclusive. Each pair is "clear" (nothing else fits either side, the dates are within 3 days, and no category would be lost) or "needs_confirmation", with the reasons: several transactions fit, the dates are far apart, or linking would drop a category. Link the clear ones with link_transfers, and ask the person about each one that needs confirmation before linking it. Read-only.',
  kind: 'read',
  input: {
    start_date: isoDate
      .optional()
      .describe(
        'First day to include, YYYY-MM-DD. Omit to start at the beginning.',
      ),
    end_date: isoDate
      .optional()
      .describe('Last day to include, YYYY-MM-DD. Omit to go to the end.'),
    account_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Only pairs with a side in this account (id from list_accounts). Omit for all accounts.',
      ),
    window_days: z
      .number()
      .int()
      .min(1)
      .max(MAX_WINDOW_DAYS)
      .default(DEFAULT_WINDOW_DAYS)
      .describe(
        `How many days apart the two sides may be (default ${DEFAULT_WINDOW_DAYS}). A bank can take days to post a payment.`,
      ),
    status: z
      .enum(['all', 'clear', 'needs_confirmation'])
      .default('all')
      .describe('Which pairs to list (default all).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Pairs to list, oldest first (default 50).'),
  },
  output: {
    window_days: z.number(),
    scanned: z
      .number()
      .describe('How many unlinked transactions were looked at.'),
    clear_count: z.number().describe('All clear pairs, across every page.'),
    needs_confirmation_count: z
      .number()
      .describe('All pairs needing confirmation, across every page.'),
    returned: z.number(),
    has_more: z.boolean(),
    matches: z.array(matchSchema),
  },
  async handler(input, ctx) {
    if (
      input.start_date &&
      input.end_date &&
      input.start_date > input.end_date
    ) {
      throw toolError(
        `start_date (${input.start_date}) must not be after end_date (${input.end_date}).`,
      );
    }
    const accountId = input.account_id;
    if (accountId) await assertKnownAccount(ctx, accountId);

    const pool = await loadUnlinkedPool(ctx, {
      startDate: input.start_date,
      endDate: input.end_date,
    });
    const found = findTransferMatches(pool, { windowDays: input.window_days });

    const involvesAccount = (match: (typeof found)[number]) =>
      !accountId ||
      [match.from, match.to, ...match.alternatives].some(
        side => side?.account_id === accountId,
      );
    const inScope = found.filter(involvesAccount);
    const clearCount = inScope.filter(m => m.status === 'clear').length;
    const confirmCount = inScope.length - clearCount;

    const listed = inScope.filter(
      match => input.status === 'all' || match.status === input.status,
    );
    const page = listed.slice(0, input.limit);
    const matches = page.map(match => ({
      status: match.status,
      from: toSide(ctx.amounts, match.from),
      to: match.to ? toSide(ctx.amounts, match.to) : null,
      alternatives: match.alternatives.map(side => toSide(ctx.amounts, side)),
      competing: match.competing.map(side => toSide(ctx.amounts, side)),
      days_apart: match.days_apart,
      reasons: match.reasons,
    }));

    const lines = matches.map(match => {
      const head = `[${match.status === 'clear' ? 'clear' : 'confirm'}] ${describeSide(ctx.amounts, match.from)}`;
      const arrow = match.to
        ? `  ->  ${describeSide(ctx.amounts, match.to)} (${match.days_apart} day(s) apart)`
        : '  ->  (no single nearest match)';
      const why =
        match.reasons.length > 0
          ? `\n    ask because: ${describeReasons(match.reasons)}`
          : '';
      const others =
        match.alternatives.length > 1
          ? `\n    could also be: ${match.alternatives.map(side => describeSide(ctx.amounts, side)).join(' | ')}`
          : '';
      const rivals =
        match.competing.length > 0
          ? `\n    also fits: ${match.competing.map(side => describeSide(ctx.amounts, side)).join(' | ')}`
          : '';
      return `${head}${arrow}${why}${others}${rivals}`;
    });
    const header = `Looked at ${pool.length} unlinked transaction(s): ${clearCount} clear pair(s), ${confirmCount} needing confirmation, window ${input.window_days} day(s)${page.length < listed.length ? `; showing the first ${page.length} of ${listed.length}` : ''}`;

    return {
      data: {
        window_days: input.window_days,
        scanned: pool.length,
        clear_count: clearCount,
        needs_confirmation_count: confirmCount,
        returned: matches.length,
        has_more: page.length < listed.length,
        matches,
      },
      text: [header, ...lines].join('\n'),
    };
  },
});
