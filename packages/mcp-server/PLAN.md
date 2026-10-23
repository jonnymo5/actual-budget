# Actual MCP Server — Implementation Plan

Build a first-party MCP server as a new workspace package (`packages/mcp-server`,
npm name `@actual-app/mcp-server`) in this fork. It exposes the user's Actual
Budget data to Claude (Claude Code + Claude Desktop) for:

1. **Plain-language queries** over accounts, transactions, budgets.
2. **Categorization help** — finding uncategorized/miscategorized transactions,
   bulk-applying categories, maintaining rules.
3. **Statement import** — CSV, OFX/QFX, and PDF statements (PDF/CSV parsed by
   Claude client-side; the server receives structured rows).
4. **Analysis** — spending summaries, trends, outliers, recurring detection,
   cash-flow projections.
5. **Extensibility** — future fork features get exposed by adding tool modules.

## Decisions already made (do not re-litigate)

- **Transports: both.** stdio for local dev / direct Claude Code use, and
  Streamable HTTP for the deployed container on the Unraid host (wolverine).
- **Network: Tailscale only.** No public exposure, no Funnel. Clients are
  Claude Code and Claude Desktop on tailnet devices.
- **Write policy: gated writes.** Full read+write toolset; bulk/destructive
  operations are dry-run by default and applied only with an explicit flag.
  `ACTUAL_MCP_READ_ONLY=1` registers read tools only.
- **No dependency on community MCP servers.** They may be read for reference
  (henfrydls/actual-budget-mcp, s-stefanov/actual-mcp) but no code is vendored.
- **Fork hygiene: new files only.** Like `.github/workflows/unraid-image.yml`,
  everything lives in new files/dirs so upstream syncs never conflict. The
  root `package.json` workspaces glob (`packages/*`) and lage pick up the new
  package automatically — do not edit root config files.

## Verified codebase facts (use these, don't rediscover)

- `@actual-app/api` (source: `packages/api/methods.ts`, `packages/api/index.ts`)
  exposes everything needed:
  - lifecycle: `init({ dataDir, serverURL, password })`, `shutdown()`,
    `downloadBudget(syncId, { password })`, `loadBudget`, `getBudgets`, `sync()`,
    `batchBudgetUpdates(fn)`, `getServerVersion()`
  - data: `getAccounts/createAccount/updateAccount/closeAccount/...`,
    `getAccountBalance(id, cutoff?)`, `getTransactions(accountId, startDate, endDate)`,
    `addTransactions`, `importTransactions` (dedupes via `imported_id`, runs rules),
    `updateTransaction`, `deleteTransaction`, `mergeTransactions`,
    `getCategories/getCategoryGroups` + CRUD, `getPayees/getCommonPayees` + CRUD,
    `mergePayees`, `getTags` + CRUD, `getNote/updateNote`
  - rules: `getRules()`, `getPayeeRules(payeeId)`, `createRule`, `updateRule`,
    `deleteRule`
  - budget: `getBudgetMonths()`, `getBudgetMonth(month)`, `setBudgetAmount`,
    `setBudgetCarryover`, `holdBudgetForNextMonth`, `resetBudgetHold`
  - schedules: `getSchedules`, `createSchedule`, `updateSchedule`, `deleteSchedule`
  - ActualQL: `q` (query builder, re-exported from `methods.ts`) + `runQuery(query)` /
    `aqlQuery(query)`
  - `utils` (from `packages/api/utils.ts`) includes amount conversion helpers.
- **Amounts are integers in minor units** (cents) everywhere in the API.
  Convention for this server: all tool inputs/outputs use **major units**
  (e.g. dollars, as numbers); convert at the boundary in one shared util.
  Dates are `YYYY-MM-DD` strings; budget months are `YYYY-MM`.
- loot-core's package exports include `./server/*`, so
  `@actual-app/core/server/transactions/import/ofx2json` is importable — it is
  pure (OFX/QFX string in → `{ headers, transactions[{ fitId, date, amount,
  name, memo }] }` out, deps: xml2js + shared/months). Use it for OFX parsing.
  Do **not** use `parse-file.ts` (fs-bound, `@ts-strict-ignore`).
- Test bootstrap pattern: copy `packages/api/methods.test.ts` — it creates a
  budget from `packages/loot-core/src/mocks/files/default-budget-template`
  into a temp dataDir, calls `api.init({ dataDir })` with a `vi.mock` of
  `../loot-core/src/platform/server/fs/index.api` to fix migration paths, and
  `api.shutdown()` in `afterEach`. No sync server needed for tests.
- Deployment target: `deploy/unraid/docker-compose.yml` — a tailscale sidecar
  (`actual-tailscale`, tailnet hostname `actual`) serves
  `https://actual.<tailnet>.ts.net` and proxies to `actual-server:5006` by
  container name; no LAN ports; Watchtower (fork) auto-deploys images labelled
  `com.centurylinklabs.watchtower.enable=true`; images are built by the
  fork-only workflow `.github/workflows/unraid-image.yml` →
  `ghcr.io/<owner>/actual-server:{latest,sha-<hash>}`.

## Architecture

```
packages/mcp-server/
  package.json            # @actual-app/mcp-server, private, node >=22
  tsconfig.json           # mirror packages/api; type-strict (NO @ts-strict-ignore)
  PLAN.md                 # this file
  README.md               # setup + client config (written in Phase 5)
  vitest.config.ts
  src/
    index.ts              # CLI entry: picks stdio vs http from argv/env
    server.ts             # builds McpServer, registers tool modules
    config.ts             # env parsing/validation (one place, typed)
    actual/
      session.ts          # init/downloadBudget lifecycle, retry, shutdown hooks
      mutex.ts            # async mutex — ALL tool handlers run serialized
      sync.ts             # debounced sync-before-read, sync-after-write
      amounts.ts          # integer<->major-unit conversion, date helpers
    tools/
      registry.ts         # registerTool wrapper: zod schemas, readOnly flag,
                          # dryRun/confirm conventions, error mapping
      query/*.ts          # Phase 1 tools (one file per tool)
      analysis/*.ts       # Phase 2
      categorize/*.ts     # Phase 3
      rules/*.ts          # Phase 3
      import/*.ts         # Phase 4
    transports/
      stdio.ts
      http.ts             # Phase 5: express + StreamableHTTPServerTransport,
                          # optional bearer auth
  docker/
    Dockerfile            # Phase 5
```

Key design rules:

- **MCP SDK**: `@modelcontextprotocol/sdk` (latest 1.x), `McpServer` +
  `registerTool`, input/output schemas in zod. Tool results return both
  `structuredContent` and a compact human-readable text block.
- **Single Actual session, serialized access.** `@actual-app/api` is a global
  singleton — wrap every tool handler in the mutex. On startup:
  `init({ dataDir, serverURL, password })` → `downloadBudget(syncId,
  { password: encryptionPassword? })`. Call `sync()` before reads (debounced,
  e.g. ≥30s since last) and after every successful write.
- **Separation of layers**: tool files contain MCP schema + thin handler;
  computation lives in plain functions (e.g. `src/analysis/trends.ts`) so
  future fork features reuse them and tests hit them directly.
- **Gated writes convention** (enforced by `registry.ts`):
  - Bulk/mutating tools take `dry_run` (default **true**). Dry run returns a
    preview: counts, per-item before/after samples (cap ~20), and warnings.
    The caller re-invokes with `dry_run: false` to apply.
  - Delete tools additionally require `confirm: true` (error without it).
  - Tools registered with `write: true` are skipped entirely when
    `ACTUAL_MCP_READ_ONLY=1`.
- **Errors**: map Actual API errors to MCP tool errors with actionable
  messages (e.g. "unknown category 'Foo' — call get_categories").
- **Repo conventions apply** (see `AGENTS.md` / `CLAUDE.md`): functional style
  (no classes), `function` keyword for pure functions, `satisfies` over `as`,
  new files type-strict, descriptive names, oxlint rules.

### Configuration (env vars, parsed in `config.ts`)

| Var | Required | Notes |
| --- | --- | --- |
| `ACTUAL_SERVER_URL` | yes | `http://actual-server:5006` in-stack; `https://actual.<tailnet>.ts.net` from the Mac |
| `ACTUAL_SERVER_PASSWORD` | yes | sync server password |
| `ACTUAL_SYNC_ID` | yes | budget Sync ID (Settings → Advanced in Actual) |
| `ACTUAL_BUDGET_ENCRYPTION_PASSWORD` | no | only if E2E encryption enabled |
| `ACTUAL_DATA_DIR` | no | default: OS tmp subdir; a persistent volume in Docker |
| `ACTUAL_MCP_READ_ONLY` | no | `1` hides all write tools |
| `MCP_HTTP_PORT` | http mode | default 3600 |
| `MCP_AUTH_TOKEN` | no | if set, HTTP requires `Authorization: Bearer <token>`; unset = tailnet-trust |

## Tool catalog

Names are `snake_case`. Every tool description must state units (major
currency units) and date formats, since the model reads them.

### Phase 1 — read & query

| Tool | Input | Output |
| --- | --- | --- |
| `get_overview` | — | budget name, accounts with balances, date range of data, category group names, server version. The "orient yourself" call. |
| `list_accounts` | `include_closed?` | accounts + current balances |
| `get_transactions` | `account_id?`, `start_date`, `end_date`, `category?`, `payee?`, `min_amount?`, `max_amount?`, `search_text?`, `limit?`, `offset?` | transactions (id, date, account, payee, category, amount, notes, cleared). Omitted `account_id` = all accounts (via ActualQL, not per-account loops). |
| `get_categories` | `include_hidden?` | category groups with categories |
| `get_payees` | `search?` | payees (id, name) |
| `get_budget_months` | — | list of `YYYY-MM` |
| `get_budget_month` | `month` | budgeted/spent/balance per category |
| `get_schedules` | — | schedules with next dates, amounts, frequency |
| `get_rules` | `payee_id?` | all rules (or payee-linked) with conditions/actions |
| `run_query` | structured ActualQL: `{ table, filter?, select?, group_by?, order_by?, limit?, calculate? }` | rows. Build with `q()` server-side; validate table ∈ {transactions, accounts, categories, payees, schedules}. Escape hatch for questions no dedicated tool answers. |

### Phase 2 — analysis

Computed server-side from ActualQL aggregations (don't ship thousands of raw
rows back to the model):

| Tool | Purpose |
| --- | --- |
| `spending_summary` | totals grouped by category/category-group/payee/month over a date range; optional compare-to-previous-period deltas |
| `spending_trends` | monthly time series per category (or total), with simple linear trend + month-over-month / year-over-year changes |
| `find_outliers` | unusual transactions: amount z-score/IQR within its category or payee history, new payees with large first transactions, potential duplicates (same amount±, date±N days, same payee) |
| `detect_recurring` | known schedules + inferred recurring charges from history (same payee, regular cadence, similar amount); flags recurring charges that stopped or jumped in price |
| `cash_flow_projection` | project N months ahead from scheduled transactions + trailing per-category averages; per-account running balances; configurable horizon/assumptions |
| `month_comparison` | budgeted vs actual for a month, biggest overspends/underspends |

### Phase 3 — categorization & rules

| Tool | Write? | Purpose |
| --- | --- | --- |
| `get_uncategorized` | no | uncategorized transactions, grouped by payee with counts/totals (the workflow feed) |
| `categorize_transactions` | gated | bulk `[{ transaction_id, category }]`; dry run previews before/after |
| `update_transaction` | gated | single-transaction edits (payee, notes, splits out of scope v1) |
| `preview_rule` | no | given conditions (payee/amount/notes/date ops), show matching transactions + count — translate the common condition types to an ActualQL filter |
| `create_rule` / `update_rule` | gated | dry run returns the `preview_rule` result + the rule as it would be saved |
| `delete_rule` | gated + `confirm` | |
| `apply_rules_retroactively` | gated | run a rule's actions over existing matching transactions (preview first) |

Division of labor: **Claude decides** what category fits or what rule to
propose (it can see payee names and history via Phase 1/2 tools); the server
provides correct, safe, previewable application.

### Phase 4 — statement import

| Tool | Write? | Purpose |
| --- | --- | --- |
| `parse_ofx` | no | OFX/QFX file content (string) → normalized rows with `imported_id` = FITID, via loot-core's `ofx2json` |
| `import_transactions` | gated | `account_id` + structured rows `[{ date, amount, payee_name, notes?, imported_id?, category? }]`. Dry run classifies each row new/duplicate/updated (dedupe on `imported_id`, fuzzy date+amount otherwise — mirror what `importTransactions` will do, then apply with the real `importTransactions`, report added/updated ids). Rules run on import automatically. |
| `reconcile_account` | no | compare statement ending balance vs `getAccountBalance(id, cutoff)`; report difference and candidate missing/duplicate transactions |

Flow by format: **OFX/QFX** → client reads the file, passes content to
`parse_ofx`, then `import_transactions`. **CSV** → Claude reads the CSV
itself, maps columns (per-bank quirks live in the conversation or a saved
note), calls `import_transactions` with structured rows. **PDF** → Claude
extracts rows from the PDF itself, same path. No server-side PDF parsing.

### Phase 5 — HTTP transport, Docker, deployment

Covered in the phase breakdown below.

## Phase breakdown (one PR per phase)

Each phase: branch from `master`, implement, `yarn typecheck && yarn lint:fix
&& yarn test` from the repo root, add a release note in
`upcoming-release-notes/` (short, plain language), PR title prefixed `[AI]`,
PR template left untouched. The git-guard hook blocks pushing to master; the
user merges PRs via GitHub UI.

### Phase 0 — scaffold + session layer + first tools (prove the pipeline)

1. Create the package (files above): `package.json` (private, scripts:
   `build` [tsc emit → `dist/`, no bundler needed for Node-only], `test`
   [`vitest --run`], `typecheck` [mirror `packages/api`: `tsgo -b &&
   tsc-strict`], `start` [stdio via tsx]), deps:
   `@actual-app/api: workspace:*`, `@actual-app/core: workspace:*`,
   `@modelcontextprotocol/sdk`, `zod`, `express` (declared now or in Phase 5).
2. `config.ts`, `actual/session.ts` (+ mutex, sync, amounts), `tools/registry.ts`.
3. Implement `get_overview`, `list_accounts`, `get_transactions`.
4. stdio transport + `src/index.ts` entry.
5. Tests: registry conventions (dry-run/confirm/read-only gating) + the three
   tools against a template budget (copy `packages/api/methods.test.ts`
   bootstrap, including the fs mock).
6. Verify `yarn workspaces list` shows the package and root
   typecheck/lint/test pass.

**Acceptance**: from this repo, `claude mcp add actual-dev -- yarn workspace
@actual-app/mcp-server start` (stdio, env vars set) lets Claude Code answer
"what accounts do I have and what did I spend at <payee> last month?"
against a real budget.

### Phase 1 — complete read/query toolset

Remaining Phase 1 tools; `run_query` validation (reject unknown tables/fields
with helpful messages); unit tests per tool incl. amount/date conversion
round-trips.

**Acceptance**: arbitrary natural-language questions about historical data are
answerable without `run_query` for the common cases, and with it for the rest.

### Phase 2 — analysis

Pure computation modules under `src/analysis/` with direct unit tests (synthetic
transaction fixtures with known trends/outliers/recurring patterns), plus thin
tool wrappers. Watch output size: summaries and top-N, never full dumps.

**Acceptance**: "where is my spending trending up?", "any weird charges this
month?", "project my checking balance through March" produce correct, concise
results on the template/test budget.

### Phase 3 — categorization & rules

Rule condition translation (`preview_rule`) is the subtle part: support
payee/payee_name (is/contains/one-of), amount (is/gt/lt/between), notes
(contains/matches), date (is/gte/lte) — document unsupported operators in the
tool description rather than guessing. Use `getRules`/`createRule`/`updateRule`
and validate category/payee ids before writes.

**Acceptance**: full workflow on test budget — find uncategorized → bulk
categorize (dry run then apply) → create a rule so next import auto-categorizes
→ retroactively apply it — all with correct previews.

### Phase 4 — import

`parse_ofx` via `@actual-app/core/server/transactions/import/ofx2json`;
`import_transactions` dry-run classification + real `importTransactions`
apply; `reconcile_account`. Tests: OFX fixture files (sanitized), duplicate
re-import is a no-op, dry-run classification matches apply results.

**Acceptance**: importing the same OFX twice adds zero duplicates; a CSV-shaped
row import with rules in place lands categorized; reconcile catches a
deliberately removed transaction.

### Phase 5 — HTTP transport, Docker, wolverine deployment

1. `transports/http.ts`: express + `StreamableHTTPServerTransport` at `/mcp`
   (stateless mode is fine — tools are stateless given the session layer),
   `/healthz` endpoint, optional bearer auth (`MCP_AUTH_TOKEN`).
2. `docker/Dockerfile`: model on the sync-server image + unraid-image.yml
   approach — build in CI on linux/amd64, prod-only install, run as non-root,
   `ACTUAL_DATA_DIR` on a volume, healthcheck hitting `/healthz`.
3. New fork-only workflow `.github/workflows/unraid-mcp-image.yml` (copy
   unraid-image.yml) → `ghcr.io/<owner>/actual-mcp:{latest,sha-<hash>}`.
4. Update `deploy/unraid/docker-compose.yml` (fork-owned): add `actual-mcp`
   service (env from `.env`, Watchtower label enabled, no LAN ports,
   `ACTUAL_SERVER_URL=http://actual-server:5006`, data volume under
   `/mnt/maincache/appdata/actual-budget/mcp`), and add a path route to the
   existing tailscale serve config: `"/mcp": { "Proxy": "http://actual-mcp:3600/mcp" }`
   — same tailnet node, so the endpoint is `https://actual.<tailnet>.ts.net/mcp`.
5. `README.md`: env reference; client setup —
   - Claude Code: `claude mcp add --transport http actual
     https://actual.<tailnet>.ts.net/mcp` (+ `--header "Authorization:
     Bearer …"` if token set)
   - Claude Desktop: custom connector to the same URL if no token; otherwise
     the `mcp-remote` stdio shim with header support
   - local stdio dev config.
6. Update `deploy/unraid/README.md` with the new service's setup steps.

**Acceptance**: container runs on wolverine; Claude Code and Claude Desktop on
a tailnet Mac answer data questions via the HTTPS URL; Watchtower picks up a
new image on master merge.

## Testing & quality bar (all phases)

- Vitest, real `@actual-app/api` against a temp dataDir — minimize mocks
  (repo policy). The api fs mock from `methods.test.ts` is the one exception.
- Every tool: happy path + at least one validation failure + (write tools)
  dry-run/apply/read-only-hidden tests.
- No `@ts-strict-ignore` anywhere in the package. `yarn typecheck`,
  `yarn lint`, `yarn test` green from root before every PR.

## Explicit non-goals (v1)

- No bank-sync (GoCardless/SimpleFIN) management, no split transactions,
  no budget template management, no multi-budget switching (single
  `ACTUAL_SYNC_ID`), no server-side PDF/CSV parsing, no OAuth, no public
  exposure, no MCP resources/prompts (tools only; revisit later).
