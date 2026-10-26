import { z } from 'zod';

import {
  applyCreations,
  applyLinks,
  loadTransferSides,
  loadUnlinkedPool,
  resolveAccount,
  transferDropsCategory,
  transferPayees,
} from '#actual/transfers';
import type {
  AccountInfo,
  CreateOp,
  LinkOp,
  TransferSide,
} from '#actual/transfers';
import { addDays } from '#analysis/dates';
import {
  assessPair,
  DEFAULT_WINDOW_DAYS,
  findExistingCounterparts,
  MAX_WINDOW_DAYS,
} from '#analysis/transfers';
import type { MatchReason } from '#analysis/transfers';
import { defineTool } from '#tools/registry';

import {
  describeReasons,
  describeSide,
  reasonSchema,
  sideSchema,
  toSide,
} from './shared';

const MAX_PAIRS = 200;

const pairInput = z.object({
  transaction_id: z
    .string()
    .min(1)
    .describe('One side of the transfer (id from get_transactions).'),
  counterpart_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The other side, a transaction that already exists in another account (id from find_transfer_candidates or get_transactions).',
    ),
  counterpart_account: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Instead of counterpart_id: an account (name or id) to create the other side in, for money that came from or went to an account you track but have not imported, such as a savings or investment account.',
    ),
});

const pairResult = z.object({
  status: z
    .enum(['ready', 'needs_confirmation', 'skipped'])
    .describe(
      '"ready": will be linked. "needs_confirmation": would be linked, but only with allow_uncertain, so ask the person first. "skipped": cannot be linked, see skipped_reason.',
    ),
  mode: z
    .enum(['link_existing', 'create_counterpart'])
    .nullable()
    .describe('Null when the request was unusable.'),
  transaction_id: z.string(),
  from: sideSchema
    .nullable()
    .describe('The side where money left; null when it could not be read.'),
  to: sideSchema
    .nullable()
    .describe(
      'The side where money arrived; null when it is to be created or could not be read.',
    ),
  create_in: z
    .string()
    .nullable()
    .describe('The account the other side is created in, when it is created.'),
  category_cleared: z
    .boolean()
    .describe(
      'True when Actual drops the category, because both accounts are on budget (or both are off).',
    ),
  reasons: reasonSchema.array(),
  skipped_reason: z.string().nullable(),
  linked: z.boolean().describe('True once the transfer has really been made.'),
});

type PairResult = z.output<typeof pairResult>;

export const linkTransfers = defineTool({
  name: 'link_transfers',
  title: 'Link transactions as transfers',
  description: `Turns pairs of transactions into transfers between your own accounts, so Actual stops counting them as income or spending. Give each pair as transaction_id plus either counterpart_id (the other side already exists in another account) or counterpart_account (the other side does not exist yet: it is created in that account, which is how to record money moved in from or out to a savings or investment account you track as an off-budget account). Both sides must have exactly opposite amounts, be in different accounts, not already be transfers and not be part of a split. Actual drops the category of a transfer between two on-budget (or two off-budget) accounts, so the preview says when that happens; a transfer between an on-budget and an off-budget account keeps it. Amounts are in major currency units (e.g. dollars, not cents) and signed; dates are YYYY-MM-DD. At most ${MAX_PAIRS} pairs per call. Pairs that find_transfer_candidates calls "needs_confirmation" are refused unless allow_uncertain is true: ask the person about those first, then link just the ones they confirm.`,
  kind: 'write',
  input: {
    pairs: z
      .array(pairInput)
      .min(1)
      .max(MAX_PAIRS)
      .describe('The transfers to make.'),
    allow_uncertain: z
      .boolean()
      .default(false)
      .describe(
        'Link pairs that need confirmation too. Pass true only for pairs the person has agreed to.',
      ),
    window_days: z
      .number()
      .int()
      .min(1)
      .max(MAX_WINDOW_DAYS)
      .default(DEFAULT_WINDOW_DAYS)
      .describe(
        `How far apart other transactions may be and still count as a rival match (default ${DEFAULT_WINDOW_DAYS}).`,
      ),
  },
  output: {
    requested: z.number(),
    ready_count: z.number(),
    needs_confirmation_count: z.number(),
    skipped_count: z.number(),
    linked_count: z
      .number()
      .describe('Transfers made; always 0 for a preview.'),
    pairs: z.array(pairResult),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    const windowDays = input.window_days;
    const wantedIds = input.pairs.flatMap(pair => [
      pair.transaction_id,
      ...(pair.counterpart_id ? [pair.counterpart_id] : []),
    ]);
    const sides = await loadTransferSides(ctx, wantedIds);

    // The unlinked transactions around the ones asked about, to tell a pair
    // that is the only fit from one with a rival.
    const dates = [...sides.values()].map(side => side.date).sort();
    const pool =
      dates.length === 0
        ? []
        : await loadUnlinkedPool(ctx, {
            startDate: addDays(dates[0], -windowDays),
            endDate: addDays(dates[dates.length - 1], windowDays),
          });
    const payees = await transferPayees(ctx);
    const accounts = new Map<string, AccountInfo>();

    const used = new Set<string>();
    const linkOps = new Map<number, LinkOp>();
    const createOps = new Map<number, CreateOp>();
    const results: PairResult[] = [];

    function skipped(
      pair: z.output<typeof pairInput>,
      reason: string,
      extra: Partial<PairResult> = {},
    ): PairResult {
      return {
        status: 'skipped',
        mode: null,
        transaction_id: pair.transaction_id,
        from: null,
        to: null,
        create_in: null,
        category_cleared: false,
        reasons: [],
        skipped_reason: reason,
        linked: false,
        ...extra,
      };
    }

    for (const [index, pair] of input.pairs.entries()) {
      if (
        (pair.counterpart_id === undefined) ===
        (pair.counterpart_account === undefined)
      ) {
        results.push(
          skipped(
            pair,
            'give exactly one of counterpart_id and counterpart_account',
          ),
        );
        continue;
      }

      const first = sides.get(pair.transaction_id);
      const problem = (side: TransferSide | undefined, label: string) => {
        if (!side) return `${label} is not a transaction (unknown id)`;
        if (side.is_transfer) return `${label} is already a transfer`;
        if (side.is_split) return `${label} is part of a split transaction`;
        if (used.has(side.id)) {
          return `${label} is already in an earlier pair of this request`;
        }
        return null;
      };
      const firstProblem = problem(first, 'transaction_id');
      if (firstProblem || !first) {
        results.push(skipped(pair, firstProblem ?? 'unknown transaction'));
        continue;
      }

      if (pair.counterpart_id !== undefined) {
        const second = sides.get(pair.counterpart_id);
        const secondProblem = problem(second, 'counterpart_id');
        if (secondProblem || !second) {
          results.push(skipped(pair, secondProblem ?? 'unknown counterpart'));
          continue;
        }
        if (first.id === second.id) {
          results.push(
            skipped(pair, 'a transaction cannot be its own counterpart'),
          );
          continue;
        }
        if (first.account_id === second.account_id) {
          results.push(
            skipped(pair, 'both transactions are in the same account', {
              from: toSide(ctx.amounts, first),
              to: toSide(ctx.amounts, second),
            }),
          );
          continue;
        }
        if (first.amount + second.amount !== 0) {
          results.push(
            skipped(
              pair,
              `the amounts do not cancel out (${ctx.amounts.format(ctx.amounts.toMajor(first.amount))} and ${ctx.amounts.format(ctx.amounts.toMajor(second.amount))})`,
              {
                from: toSide(ctx.amounts, first),
                to: toSide(ctx.amounts, second),
              },
            ),
          );
          continue;
        }

        const [from, to] = first.amount < 0 ? [first, second] : [second, first];
        const fromPayee = payees.get(to.account_id);
        const toPayee = payees.get(from.account_id);
        if (!fromPayee || !toPayee) {
          results.push(
            skipped(
              pair,
              `an account has no transfer payee (${fromPayee ? from.account : to.account})`,
            ),
          );
          continue;
        }

        const reasons = assessPair(pool, from, to, { windowDays });
        const clear = transferDropsCategory(from, to);
        used.add(from.id).add(to.id);
        linkOps.set(index, {
          first: from,
          second: to,
          firstPayee: fromPayee,
          secondPayee: toPayee,
          clearCategory: clear,
        });
        results.push({
          status: reasons.length === 0 ? 'ready' : 'needs_confirmation',
          mode: 'link_existing',
          transaction_id: pair.transaction_id,
          from: toSide(ctx.amounts, from),
          to: toSide(ctx.amounts, to),
          create_in: null,
          category_cleared:
            clear && (from.category_id !== null || to.category_id !== null),
          reasons,
          skipped_reason: null,
          linked: false,
        });
        continue;
      }

      // counterpart_account: create the other side.
      const accountText = pair.counterpart_account ?? '';
      let target = accounts.get(accountText);
      if (!target) {
        target = await resolveAccount(ctx, accountText);
        accounts.set(accountText, target);
      }
      if (target.id === first.account_id) {
        results.push(
          skipped(pair, 'the other side cannot be in the same account', {
            from: toSide(ctx.amounts, first),
          }),
        );
        continue;
      }
      const payee = payees.get(target.id);
      if (!payee) {
        results.push(
          skipped(pair, `account ${target.name} has no transfer payee`, {
            from: toSide(ctx.amounts, first),
          }),
        );
        continue;
      }

      const existing = findExistingCounterparts(pool, first, target.id, {
        windowDays,
      });
      const clear = transferDropsCategory(first, {
        account_off_budget: target.off_budget,
      });
      const reasons: MatchReason[] = [];
      if (existing.length > 0) reasons.push('counterpart_already_exists');
      if (clear && first.category_id !== null) {
        reasons.push('category_would_be_cleared');
      }
      used.add(first.id);
      createOps.set(index, { side: first, payee });
      results.push({
        status: reasons.length === 0 ? 'ready' : 'needs_confirmation',
        mode: 'create_counterpart',
        transaction_id: pair.transaction_id,
        from: toSide(ctx.amounts, first),
        to: null,
        create_in: target.name,
        category_cleared: clear && first.category_id !== null,
        reasons,
        skipped_reason: null,
        linked: false,
      });
    }

    const allowed = (result: PairResult) =>
      result.status === 'ready' ||
      (result.status === 'needs_confirmation' && input.allow_uncertain);
    const toLink = [...linkOps].filter(([index]) => allowed(results[index]));
    const toCreate = [...createOps].filter(([index]) =>
      allowed(results[index]),
    );

    if (!ctx.dryRun) {
      await applyLinks(
        ctx,
        toLink.map(([, op]) => op),
      );
      await applyCreations(
        ctx,
        toCreate.map(([, op]) => op),
      );
      for (const [index] of [...toLink, ...toCreate]) {
        results[index].linked = true;
      }
    }

    const count = (status: PairResult['status']) =>
      results.filter(result => result.status === status).length;
    const linked = results.filter(result => result.linked).length;

    const warnings: string[] = [];
    const involved = [...linkOps, ...createOps]
      .filter(([index]) => allowed(results[index]))
      .flatMap(([, op]) => ('side' in op ? [op.side] : [op.first, op.second]));
    const reconciled = involved.filter(side => side.reconciled).length;
    if (reconciled > 0) {
      warnings.push(
        `${reconciled} of these transactions are reconciled (locked in Actual's own screens); they are changed all the same.`,
      );
    }
    if (input.allow_uncertain && count('needs_confirmation') > 0) {
      warnings.push(
        `${count('needs_confirmation')} pair(s) needed confirmation and were included because allow_uncertain is true.`,
      );
    }

    const describe = (result: PairResult) => {
      const tag = result.linked
        ? 'LINKED'
        : {
            ready: 'ready',
            needs_confirmation: 'ASK FIRST',
            skipped: 'SKIPPED',
          }[result.status];
      const left = result.from
        ? describeSide(ctx.amounts, result.from)
        : `[id: ${result.transaction_id}]`;
      const right = result.to
        ? describeSide(ctx.amounts, result.to)
        : result.create_in
          ? `(new side in ${result.create_in})`
          : '';
      const extra = [
        result.category_cleared ? 'its category will be dropped' : '',
        result.reasons.length > 0 ? describeReasons(result.reasons) : '',
        result.skipped_reason ?? '',
      ].filter(Boolean);
      return `[${tag}] ${left}${right ? `  <->  ${right}` : ''}${extra.length > 0 ? `\n    ${extra.join('; ')}` : ''}`;
    };

    const header = ctx.dryRun
      ? `Would link ${toLink.length + toCreate.length} of ${results.length} pair(s): ${count('ready')} ready, ${count('needs_confirmation')} need confirmation${input.allow_uncertain ? ' (included, allow_uncertain is true)' : ' (left out)'}, ${count('skipped')} skipped.`
      : `Linked ${linked} of ${results.length} pair(s); ${count('skipped')} skipped${input.allow_uncertain ? '' : `, ${count('needs_confirmation')} left for confirmation`}.`;

    return {
      data: {
        requested: results.length,
        ready_count: count('ready'),
        needs_confirmation_count: count('needs_confirmation'),
        skipped_count: count('skipped'),
        linked_count: linked,
        pairs: results,
        warnings,
      },
      text: [header, ...results.map(describe)].join('\n'),
    };
  },
});
