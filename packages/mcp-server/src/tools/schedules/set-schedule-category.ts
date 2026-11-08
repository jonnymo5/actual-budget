import { z } from 'zod';

import { createLookups } from '#actual/lookup';
import type { NamedId } from '#actual/lookup';
import { queryRows } from '#actual/query';
import { isToolError } from '#errors';
import { defineTool } from '#tools/registry';

const MAX_ENTRIES = 50;

const scheduleRow = z.object({
  id: z.string(),
  name: z.string().nullish(),
  _actions: z
    .array(
      z.object({
        op: z.string(),
        field: z.string().nullish(),
        value: z.unknown().optional(),
      }),
    )
    .nullish(),
  _rsu_vest_event: z.string().nullish(),
});

type ScheduleRow = z.output<typeof scheduleRow>;

function currentCategory(schedule: ScheduleRow): string | null {
  const action = (schedule._actions ?? []).find(
    a => a.op === 'set' && a.field === 'category',
  );
  return typeof action?.value === 'string' ? action.value : null;
}

function findSchedule(
  schedules: ScheduleRow[],
  ref: string,
): ScheduleRow | string {
  const byId = schedules.find(schedule => schedule.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLocaleLowerCase();
  const matches = schedules.filter(
    schedule => (schedule.name ?? '').trim().toLocaleLowerCase() === wanted,
  );
  if (matches.length === 1) return matches[0];
  return matches.length === 0
    ? `no schedule is named "${ref}" (get_schedules lists them)`
    : `${matches.length} schedules are named "${ref}"; give its id instead`;
}

export const setScheduleCategory = defineTool({
  name: 'set_schedule_category',
  title: 'Set schedule categories',
  description:
    "Set or clear the category of existing schedules: the category Actual gives the transaction a schedule links to. Tagging a deposit schedule (a paycheck, a bonus) with an income category also lets sync_income_budget budget it in the month it is due. Give each schedule by name or id, and a category by name or id, or null to clear it. Schedules that stand for RSU vests take their grant's category and cannot be changed here; use update_rsu_grant. The preview lists each change with the category before and after.",
  kind: 'write',
  input: {
    entries: z
      .array(
        z.object({
          schedule: z
            .string()
            .min(1)
            .describe('The schedule (name or id, from get_schedules).'),
          category: z
            .string()
            .min(1)
            .nullable()
            .describe('The category (name or id), or null to clear it.'),
        }),
      )
      .min(1)
      .max(MAX_ENTRIES)
      .describe('The schedules to change.'),
  },
  output: {
    changes: z.array(
      z.object({
        schedule: z.string(),
        schedule_id: z.string(),
        before: z.string().nullable(),
        after: z.string().nullable(),
      }),
    ),
    unchanged: z
      .array(z.string())
      .describe('Schedules that already had that category.'),
    skipped: z.array(z.object({ schedule: z.string(), reason: z.string() })),
  },
  async handler({ entries }, ctx) {
    const schedules = await queryRows(
      ctx,
      ctx.api
        .q('schedules')
        .select(['id', 'name', '_actions', '_rsu_vest_event']),
      scheduleRow,
    );
    const lookups = createLookups(ctx);
    const categoryNames = new Map(
      (await ctx.api.getCategories()).map(c => [c.id, c.name] as const),
    );
    const nameOf = (id: string | null) =>
      id === null ? null : (categoryNames.get(id) ?? id);

    const changes: Array<{
      schedule: string;
      schedule_id: string;
      before: string | null;
      after: string | null;
      categoryId: string | null;
    }> = [];
    const unchanged: string[] = [];
    const skipped: Array<{ schedule: string; reason: string }> = [];

    for (const entry of entries) {
      const found = findSchedule(schedules, entry.schedule);
      if (typeof found === 'string') {
        skipped.push({ schedule: entry.schedule, reason: found });
        continue;
      }
      const label = found.name ?? found.id;
      if (found._rsu_vest_event) {
        skipped.push({
          schedule: label,
          reason:
            "it stands for an RSU vest and follows its grant's category; use update_rsu_grant",
        });
        continue;
      }
      let category: NamedId | null = null;
      if (entry.category !== null) {
        try {
          category = await lookups.category(entry.category);
        } catch (error) {
          if (!isToolError(error)) throw error;
          skipped.push({ schedule: label, reason: (error as Error).message });
          continue;
        }
      }
      const before = currentCategory(found);
      const after = category?.id ?? null;
      if (before === after) {
        unchanged.push(label);
        continue;
      }
      changes.push({
        schedule: label,
        schedule_id: found.id,
        before: nameOf(before),
        after: category?.name ?? null,
        categoryId: after,
      });
    }

    if (!ctx.dryRun) {
      for (const change of changes) {
        await ctx.lootCore.send('schedule/set-category', {
          id: change.schedule_id,
          category: change.categoryId,
        });
      }
    }

    const verb = ctx.dryRun ? 'Would change' : 'Changed';
    const lines = [
      `${verb} ${changes.length} schedule(s); ${unchanged.length} already set, ${skipped.length} skipped.`,
      ...changes.map(
        change =>
          `${change.schedule}: ${change.before ?? '(none)'} → ${change.after ?? '(none)'}`,
      ),
      ...skipped.map(skip => `Skipped ${skip.schedule}: ${skip.reason}`),
    ];
    return {
      data: {
        changes: changes.map(({ categoryId: _, ...change }) => change),
        unchanged,
        skipped,
      },
      text: lines.join('\n'),
    };
  },
});
