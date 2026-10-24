import { schema } from '@actual-app/core/server/aql/schema/index';
import { z } from 'zod';

import { toolError } from '#errors';

export const QUERYABLE_TABLES = [
  'transactions',
  'accounts',
  'categories',
  'payees',
  'schedules',
] as const;

export type QueryableTable = (typeof QUERYABLE_TABLES)[number];

export function isQueryableTable(name: string): name is QueryableTable {
  return (QUERYABLE_TABLES as readonly string[]).includes(name);
}

const fieldSchema = z.object({
  type: z.string(),
  ref: z.string().optional(),
});

// The engine's own table definitions, read once. Only the type and the table a
// field points at are needed here.
const SCHEMA = z
  .record(z.string(), z.record(z.string(), fieldSchema))
  .parse(schema);

// Bookkeeping and raw bank data that no question needs to reach.
const HIDDEN_FIELDS = new Set([
  'tombstone',
  'raw_synced_data',
  'error',
  'goal_def',
  'cleanup_def',
  'template_settings',
  'account_id',
  'custom_upcoming_length',
  '_conditions',
  '_actions',
  '_has_splits',
]);

// The only fields that hold money. The engine stores them as plain integers in
// the currency's minor unit, which is why they need converting at the edge.
const MONEY_FIELDS: Record<string, string[]> = {
  transactions: ['amount'],
  schedules: ['_amount'],
};

export type ResolvedField = {
  table: string;
  name: string;
  type: string;
  /** The table this field points at, for reference fields like `payee`. */
  ref: string | undefined;
  money: boolean;
};

function visibleFields(
  table: string,
): [string, z.output<typeof fieldSchema>][] {
  return Object.entries(SCHEMA[table] ?? {}).filter(
    ([name]) => !HIDDEN_FIELDS.has(name),
  );
}

function visibleField(table: string, name: string) {
  return HIDDEN_FIELDS.has(name) ? undefined : SCHEMA[table]?.[name];
}

/** The fields of a queryable table, in schema order. */
export function listFields(table: QueryableTable): string[] {
  return visibleFields(table).map(([name]) => name);
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// Fields worth suggesting for a name that does not exist: every field, plus
// `<reference>.name` for each reference whose target has a name.
function suggestionsFor(table: string, attempted: string): string[] {
  const candidates = visibleFields(table).flatMap(([name, field]) => [
    name,
    ...(field.ref && visibleField(field.ref, 'name') ? [`${name}.name`] : []),
  ]);
  const wanted = squash(attempted);
  if (wanted.length < 3) return [];
  return candidates
    .filter(candidate => {
      const squashed = squash(candidate);
      return squashed.includes(wanted) || wanted.includes(squashed);
    })
    .slice(0, 5);
}

export function assertQueryableTable(name: string): QueryableTable {
  if (!isQueryableTable(name)) {
    throw toolError(
      `unknown table "${name}". Queryable tables: ${QUERYABLE_TABLES.join(', ')}.`,
    );
  }
  return name;
}

/**
 * Resolves a field path such as `amount` or `category.group.name`, following
 * references through the schema. Throws an error that says what to use
 * instead when the path is wrong.
 */
export function resolveField(table: string, path: string): ResolvedField {
  const parts = path.split('.');
  let current = table;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const field = visibleField(current, part);
    if (!field) {
      const suggestions = suggestionsFor(current, part);
      const where =
        current === table
          ? `on table "${table}"`
          : `on table "${current}" (reached through "${parts.slice(0, index).join('.')}")`;
      throw toolError(
        `unknown field "${part}" ${where}. ${
          suggestions.length > 0
            ? `Did you mean: ${suggestions.join(', ')}?`
            : `Fields: ${visibleFields(current)
                .map(([name]) => name)
                .join(', ')}.`
        } Follow a reference with a dot, e.g. payee.name or category.group.name.`,
      );
    }

    if (index === parts.length - 1) {
      return {
        table: current,
        name: part,
        type: field.type,
        ref: field.ref,
        money: (MONEY_FIELDS[current] ?? []).includes(part),
      };
    }

    if (!field.ref) {
      throw toolError(
        `"${parts.slice(0, index + 1).join('.')}" is a plain ${field.type} field, so "${parts[index + 1]}" cannot be read from it. Only reference fields (like payee, account, category) can be followed with a dot.`,
      );
    }
    current = field.ref;
  }

  // Unreachable: `split` always yields at least one part.
  throw toolError(`empty field name on table "${table}".`);
}
