import { z } from 'zod';

import {
  applyMoves,
  loadTransferSides,
  resolveAccount,
  transferDropsCategory,
  transferPayees,
} from '#actual/transfers';
import type { AccountInfo, MoveOp } from '#actual/transfers';
import type { MatchReason } from '#analysis/transfers';
import { defineTool } from '#tools/registry';

import {
  describeReasons,
  describeSide,
  reasonSchema,
  sideSchema,
  toSide,
} from './shared';

const MAX_MOVES = 200;

const moveInput = z.object({
  transaction_id: z
    .string()
    .min(1)
    .describe(
      'The side of the transfer that stays where it is (id from get_transactions). It must already be a transfer.',
    ),
  move_other_side_to: z
    .string()
    .min(1)
    .describe('The account (name or id) the other side should be in.'),
});

const moveResult = z.object({
  status: z
    .enum(['ready', 'needs_confirmation', 'skipped'])
    .describe(
      '"ready": will be moved. "needs_confirmation": would be moved, but only with allow_uncertain, so ask the person first. "skipped": cannot be moved, see skipped_reason.',
    ),
  transaction_id: z.string(),
  stays: sideSchema
    .nullable()
    .describe('The side that stays; null when it could not be read.'),
  moves: sideSchema
    .nullable()
    .describe(
      'The other side as it is now, before it moves; null when it could not be read.',
    ),
  move_to: z
    .string()
    .nullable()
    .describe('The account the other side moves to; null when unusable.'),
  category_cleared: z
    .boolean()
    .describe(
      'True when Actual drops the category, because both accounts are on budget (or both are off).',
    ),
  reasons: reasonSchema.array(),
  skipped_reason: z.string().nullable(),
  moved: z
    .boolean()
    .describe('True once the other side has really been moved.'),
});

type MoveResult = z.output<typeof moveResult>;

export const moveTransfers = defineTool({
  name: 'move_transfers',
  title: 'Move the other side of transfers to another account',
  description: `Moves the other side of existing transfers to a different account, for a transfer that was linked to the wrong account (money that came from one savings or tracking account but was recorded against another). Give each move as transaction_id (the side that stays where it is) and move_other_side_to (the account the other side should be in). The other side is moved, not recreated: it keeps its id, date and cleared status, its payee becomes the staying side's account, and its notes are set to the staying side's notes, as Actual's own screens do when the payee of a transfer is changed. The transaction must already be a transfer and not part of a split, and the new account must differ from the staying side's account and from the account the other side is in now. Actual drops the category of a transfer between two on-budget (or two off-budget) accounts, so the preview says when that happens; a transfer between an on-budget and an off-budget account keeps it. To make two plain transactions a transfer use link_transfers instead. Amounts are in major currency units (e.g. dollars, not cents) and signed; dates are YYYY-MM-DD. At most ${MAX_MOVES} moves per call. A move that would drop a category is refused unless allow_uncertain is true: ask the person about those first, then move just the ones they confirm.`,
  kind: 'write',
  input: {
    moves: z
      .array(moveInput)
      .min(1)
      .max(MAX_MOVES)
      .describe('The transfers to change.'),
    allow_uncertain: z
      .boolean()
      .default(false)
      .describe(
        'Move transfers that need confirmation too. Pass true only for moves the person has agreed to.',
      ),
  },
  output: {
    requested: z.number(),
    ready_count: z.number(),
    needs_confirmation_count: z.number(),
    skipped_count: z.number(),
    moved_count: z
      .number()
      .describe('Transfers moved; always 0 for a preview.'),
    moves: z.array(moveResult),
    warnings: z.array(z.string()),
  },
  async handler(input, ctx) {
    const sides = await loadTransferSides(
      ctx,
      input.moves.map(move => move.transaction_id),
    );
    const others = await loadTransferSides(
      ctx,
      [...sides.values()].flatMap(side =>
        side.transfer_id ? [side.transfer_id] : [],
      ),
    );
    const payees = await transferPayees(ctx);
    const accounts = new Map<string, AccountInfo>();

    const used = new Set<string>();
    const ops = new Map<number, MoveOp>();
    const results: MoveResult[] = [];

    function skipped(
      move: z.output<typeof moveInput>,
      reason: string,
      extra: Partial<MoveResult> = {},
    ): MoveResult {
      return {
        status: 'skipped',
        transaction_id: move.transaction_id,
        stays: null,
        moves: null,
        move_to: null,
        category_cleared: false,
        reasons: [],
        skipped_reason: reason,
        moved: false,
        ...extra,
      };
    }

    for (const [index, move] of input.moves.entries()) {
      const side = sides.get(move.transaction_id);
      if (!side) {
        results.push(
          skipped(move, 'transaction_id is not a transaction (unknown id)'),
        );
        continue;
      }
      const stays = toSide(ctx.amounts, side);
      if (!side.transfer_id) {
        results.push(
          skipped(
            move,
            'transaction_id is not a transfer yet; use link_transfers to make it one',
            { stays },
          ),
        );
        continue;
      }
      const other = others.get(side.transfer_id);
      if (!other) {
        results.push(
          skipped(move, 'the other side of this transfer cannot be found', {
            stays,
          }),
        );
        continue;
      }
      const moves = toSide(ctx.amounts, other);
      if (side.is_split || other.is_split) {
        results.push(
          skipped(move, 'the transfer is part of a split transaction', {
            stays,
            moves,
          }),
        );
        continue;
      }
      if (used.has(side.id) || used.has(other.id)) {
        results.push(
          skipped(
            move,
            'this transfer is already in an earlier move of this request',
            { stays, moves },
          ),
        );
        continue;
      }

      let target = accounts.get(move.move_other_side_to);
      if (!target) {
        target = await resolveAccount(ctx, move.move_other_side_to);
        accounts.set(move.move_other_side_to, target);
      }
      if (target.id === side.account_id) {
        results.push(
          skipped(
            move,
            'the other side cannot be in the same account as this one',
            { stays, moves },
          ),
        );
        continue;
      }
      if (target.id === other.account_id) {
        results.push(
          skipped(move, `the other side is already in ${target.name}`, {
            stays,
            moves,
          }),
        );
        continue;
      }
      const payee = payees.get(target.id);
      if (!payee) {
        results.push(
          skipped(move, `account ${target.name} has no transfer payee`, {
            stays,
            moves,
          }),
        );
        continue;
      }

      // Actual keeps or drops the category by the accounts the transfer ends
      // up between, just as when it is made.
      const clear = transferDropsCategory(side, {
        account_off_budget: target.off_budget,
      });
      const lost =
        clear && (side.category_id !== null || other.category_id !== null);
      const reasons: MatchReason[] = lost ? ['category_would_be_cleared'] : [];
      used.add(side.id).add(other.id);
      ops.set(index, { side, counterpart: other, account: target, payee });
      results.push({
        status: reasons.length === 0 ? 'ready' : 'needs_confirmation',
        transaction_id: move.transaction_id,
        stays,
        moves,
        move_to: target.name,
        category_cleared: lost,
        reasons,
        skipped_reason: null,
        moved: false,
      });
    }

    const allowed = (result: MoveResult) =>
      result.status === 'ready' ||
      (result.status === 'needs_confirmation' && input.allow_uncertain);
    const toMove = [...ops].filter(([index]) => allowed(results[index]));

    if (!ctx.dryRun) {
      await applyMoves(
        ctx,
        toMove.map(([, op]) => op),
      );
      for (const [index] of toMove) results[index].moved = true;
    }

    const count = (status: MoveResult['status']) =>
      results.filter(result => result.status === status).length;
    const moved = results.filter(result => result.moved).length;

    const warnings: string[] = [];
    const reconciled = toMove
      .flatMap(([, op]) => [op.side, op.counterpart])
      .filter(side => side.reconciled).length;
    if (reconciled > 0) {
      warnings.push(
        `${reconciled} of these transactions are reconciled (locked in Actual's own screens); they are changed all the same.`,
      );
    }
    if (input.allow_uncertain && count('needs_confirmation') > 0) {
      warnings.push(
        `${count('needs_confirmation')} move(s) needed confirmation and were included because allow_uncertain is true.`,
      );
    }

    const describe = (result: MoveResult) => {
      const tag = result.moved
        ? 'MOVED'
        : {
            ready: 'ready',
            needs_confirmation: 'ASK FIRST',
            skipped: 'SKIPPED',
          }[result.status];
      const stays = result.stays
        ? describeSide(ctx.amounts, result.stays)
        : `[id: ${result.transaction_id}]`;
      const other = result.moves
        ? `\n    other side: ${describeSide(ctx.amounts, result.moves)}${result.move_to ? `  ->  moves to ${result.move_to}` : ''}`
        : '';
      const extra = [
        result.category_cleared ? 'its category will be dropped' : '',
        result.reasons.length > 0 ? describeReasons(result.reasons) : '',
        result.skipped_reason ?? '',
      ].filter(Boolean);
      return `[${tag}] ${stays}${other}${extra.length > 0 ? `\n    ${extra.join('; ')}` : ''}`;
    };

    const header = ctx.dryRun
      ? `Would move ${toMove.length} of ${results.length} transfer(s): ${count('ready')} ready, ${count('needs_confirmation')} need confirmation${input.allow_uncertain ? ' (included, allow_uncertain is true)' : ' (left out)'}, ${count('skipped')} skipped.`
      : `Moved ${moved} of ${results.length} transfer(s); ${count('skipped')} skipped${input.allow_uncertain ? '' : `, ${count('needs_confirmation')} left for confirmation`}.`;

    return {
      data: {
        requested: results.length,
        ready_count: count('ready'),
        needs_confirmation_count: count('needs_confirmation'),
        skipped_count: count('skipped'),
        moved_count: moved,
        moves: results,
        warnings,
      },
      text: [header, ...results.map(describe)].join('\n'),
    };
  },
});
