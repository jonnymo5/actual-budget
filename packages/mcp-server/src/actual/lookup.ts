import { toolError } from '#errors';

import type { ActualContext } from './session';

export type NamedId = { id: string; name: string };

export type Lookups = {
  /** A category, from its id or exact name (case-insensitive). */
  category: (text: string) => Promise<NamedId>;
  /** A payee, from its id or exact name. Transfer payees are not accepted. */
  payee: (text: string) => Promise<NamedId>;
  /** An account, from its id or exact name. */
  account: (text: string) => Promise<NamedId>;
};

const MAX_SUGGESTIONS = 15;

type Kind = 'category' | 'payee' | 'account';

const HINTS: Record<Kind, string> = {
  category: 'get_overview lists every category',
  payee: 'get_payees searches payees by name',
  account: 'list_accounts lists every account',
};

function resolveNamed(
  kind: Kind,
  items: NamedId[],
  text: string,
  { excluded = [] }: { excluded?: NamedId[] } = {},
): NamedId {
  const trimmed = text.trim();
  const byId = items.find(item => item.id === trimmed);
  if (byId) return byId;

  const wanted = trimmed.toLowerCase();
  const matches = items.filter(item => item.name.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const options = matches.map(item => `${item.name} (${item.id})`).join(', ');
    throw toolError(
      `${kind} name "${text}" is ambiguous. Use the id of the one you mean: ${options}.`,
    );
  }

  if (
    excluded.some(
      item => item.id === trimmed || item.name.toLowerCase() === wanted,
    )
  ) {
    throw toolError(
      `"${text}" is a transfer payee, which marks a transfer between accounts and cannot be set or matched here. To make two transactions a transfer, use link_transfers.`,
    );
  }

  const similar = items.filter(item => {
    const name = item.name.toLowerCase();
    return wanted !== '' && (name.includes(wanted) || wanted.includes(name));
  });
  // Payees can number in the thousands, so they are only ever searched.
  const candidates = similar.length > 0 || kind === 'payee' ? similar : items;
  const names = candidates
    .slice(0, MAX_SUGGESTIONS)
    .map(item => item.name)
    .join(', ');
  const truncated =
    candidates.length > MAX_SUGGESTIONS
      ? ` (showing ${MAX_SUGGESTIONS} of ${candidates.length})`
      : '';
  const suggestion =
    candidates.length === 0
      ? ''
      : ` ${similar.length > 0 ? 'Did you mean' : 'Available'}: ${names}${truncated}.`;
  throw toolError(`unknown ${kind} "${text}".${suggestion} ${HINTS[kind]}.`);
}

/**
 * Resolvers for the names and ids a caller may use. Each list is read from the
 * budget once, however many values are resolved, and only things that really
 * exist can come out, so a result is always safe to write back.
 */
export function createLookups(ctx: ActualContext): Lookups {
  let categories: Promise<NamedId[]> | undefined;
  let payees: Promise<{ usable: NamedId[]; transfers: NamedId[] }> | undefined;
  let accounts: Promise<NamedId[]> | undefined;

  return {
    async category(text) {
      categories ??= ctx.api
        .getCategories()
        .then(list => list.map(({ id, name }) => ({ id, name })));
      return resolveNamed('category', await categories, text);
    },
    async payee(text) {
      payees ??= ctx.api.getPayees().then(list => ({
        usable: list
          .filter(payee => !payee.transfer_acct)
          .map(({ id, name }) => ({ id, name })),
        transfers: list
          .filter(payee => payee.transfer_acct)
          .map(({ id, name }) => ({ id, name })),
      }));
      const { usable, transfers } = await payees;
      return resolveNamed('payee', usable, text, { excluded: transfers });
    },
    async account(text) {
      accounts ??= ctx.api
        .getAccounts()
        .then(list => list.map(({ id, name }) => ({ id, name })));
      return resolveNamed('account', await accounts, text);
    },
  };
}
