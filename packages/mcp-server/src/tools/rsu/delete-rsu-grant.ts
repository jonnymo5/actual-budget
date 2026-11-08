import { normalizeTicker } from '@actual-app/core/shared/rsu';
import { z } from 'zod';

import {
  buildGrantView,
  grantViewSchema,
  loadRsuData,
  priceByTicker,
  resolveGrant,
} from '#actual/rsu';
import { listSchedules } from '#actual/schedules';
import { defineTool } from '#tools/registry';

export const deleteRsuGrant = defineTool({
  name: 'delete_rsu_grant',
  title: 'Delete an RSU grant',
  description:
    'Delete an RSU grant with all of its vest rows. The one-off schedules standing for its future vests are deleted too; schedules that were already paid stay, and transactions are never touched. The preview shows the grant and how many schedules go with it. Amounts are in major currency units (e.g. dollars, not cents); dates are YYYY-MM-DD.',
  kind: 'delete',
  input: {
    grant: z.string().min(1).describe('The grant to delete (name or id).'),
  },
  output: {
    grant_id: z.string(),
    grant: grantViewSchema.describe('The grant that is (or would be) deleted.'),
    schedules_deleted: z
      .number()
      .describe('Open schedules removed with it; paid ones are kept.'),
  },
  async handler({ grant: ref }, ctx) {
    const data = await loadRsuData(ctx);
    const grant = resolveGrant(data.grants, ref);
    const view = buildGrantView(
      ctx,
      grant,
      data.events,
      priceByTicker(data.prices).get(normalizeTicker(grant.ticker)) ?? null,
    );
    const schedules = await listSchedules(ctx, { includeCompleted: true });
    const open = new Set(
      schedules.filter(schedule => !schedule.completed).map(s => s.id),
    );
    const schedulesDeleted = view.vest_events.filter(
      row => row.schedule_id && open.has(row.schedule_id),
    ).length;

    if (!ctx.dryRun) {
      await ctx.lootCore.send('rsu-grant/delete', { id: grant.id });
    }

    return {
      data: {
        grant_id: grant.id,
        grant: view,
        schedules_deleted: schedulesDeleted,
      },
      text: `${ctx.dryRun ? 'Would delete' : 'Deleted'} RSU grant "${grant.name}" (${view.ticker}, ${view.vest_events.length} vest rows) and ${schedulesDeleted} open schedules. Transactions are not affected. [id: ${grant.id}]`,
    };
  },
});
