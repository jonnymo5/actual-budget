# Actual MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude work with an
[Actual Budget](https://actualbudget.org): answer questions about accounts and
transactions, analyse spending, categorize transactions and maintain rules, and
import bank statements.

It connects to your Actual sync server like any other Actual client, keeps its
own local copy of the budget, and pushes every change it makes back to the
server.

## What Claude can do

All amounts are in major currency units (dollars, not cents); spending is
negative. Dates are `YYYY-MM-DD`, budget months `YYYY-MM`.

| Area        | Tools                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look around | `get_overview` (start here), `list_accounts`, `get_categories`, `get_payees`, `get_transactions`, `get_budget_months`, `get_budget_month`, `get_schedules`, `get_rules`, `run_query` (read-only ActualQL for anything else) |
| Analyse     | `spending_summary`, `spending_trends`, `find_outliers`, `detect_recurring`, `cash_flow_projection`, `month_comparison`                                                                                                      |
| Categorize  | `get_uncategorized`, `categorize_transactions`, `update_transaction`                                                                                                                                                        |
| Transfers   | `find_transfer_candidates`, `link_transfers`                                                                                                                                                                                |
| Rules       | `preview_rule`, `create_rule`, `update_rule`, `delete_rule`, `apply_rules_retroactively`                                                                                                                                    |
| Import      | `parse_ofx`, `import_transactions`, `reconcile_account`                                                                                                                                                                     |

CSV and PDF statements need no server-side parsing: Claude reads them itself
and passes the rows to `import_transactions`. OFX/QFX files go through
`parse_ofx` first. Note that the file's text passes through the model, so a
very large statement is slow and costs tokens.

### Safety

- **Changes are previewed first.** Every tool that can change the budget is
  dry-run by default: it returns what it would do and changes nothing until
  called again with `dry_run: false`. `delete_rule` also needs `confirm: true`.
- **Read-only mode.** With `ACTUAL_MCP_READ_ONLY=1` the write tools are not
  registered at all, so the model cannot even see them.
- **Imports do not duplicate.** Importing the same statement twice adds
  nothing; the preview shows which rows are new, duplicates or updates of
  existing transactions.
- **Authentication.** Over HTTP, set `MCP_AUTH_TOKEN` to require a bearer
  token. Without it, anyone who can reach the port can use the server, so
  only leave it unset behind something like a private tailnet.

### Transfers

Money moved between your own accounts is a transfer, not income or spending,
and Actual leaves it out of the budget once both sides are linked. Bank
imports rarely link them: a card payment arrives as a deposit on the card and
a withdrawal from checking, so the card side looks like income and the other
like spending.

- `find_transfer_candidates` lists unlinked pairs: the same amount with
  opposite signs, in different accounts, within a few days. A pair is **clear**
  when nothing else fits either side, the dates are within three days and no
  category would be lost. Otherwise it **needs confirmation**, with the reason:
  several transactions fit (two equal payments in a week), the dates are far
  apart, or Actual would drop a category.
- `link_transfers` makes the pairs transfers. Like every write tool it is dry
  run by default. A pair that needs confirmation is refused unless
  `allow_uncertain` is true, so Claude links the clear ones, asks you about
  the rest, and links only the ones you agree to.

Linking uses the same fields as Actual's own "make transfer" (each side gets
the other account's transfer payee and a `transfer_id`), with the transfer
logic switched off so nothing is duplicated and each side keeps its own notes.
Actual drops the category of a transfer between two on-budget accounts (or two
off-budget ones); a transfer between an on-budget and an off-budget account
keeps it. The preview says when a category will go.

Import order matters if you ever give a transaction a transfer payee by other
means, such as a rule: Actual then creates the matching transaction in the
other account, which duplicates one that is already imported. Linking existing
transactions with `link_transfers` has no such problem.

#### Money from savings or an investment sale

Money you move in from savings, or from selling investments, to pay for
something is not earnings and should not make a month look richer than it was.
Track the source as an **off-budget** account in Actual (say "Investments"),
then give `link_transfers` the deposit and `counterpart_account` instead of a
`counterpart_id`. It creates the other side in that account and links the two.
You can still file the deposit under an income category such as "Starting
Balances" so the envelopes can spend it.

Analysis tools never count money transferred in from an off-budget account as
income, or as a spending offset, whatever its category. `spending_summary`
reports it separately as `savings_draws`. Money you move out to an off-budget
account with a spending category (saving, investing) is still counted as
spending.

## Configuration

Everything is read from environment variables.

| Variable                            | Required | Description                                                                                                                                                                                                                                 |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTUAL_SERVER_URL`                 | yes      | Your Actual sync server, e.g. `http://actual-server:5006`                                                                                                                                                                                   |
| `ACTUAL_SERVER_PASSWORD`            | yes      | The sync server password                                                                                                                                                                                                                    |
| `ACTUAL_SYNC_ID`                    | yes      | The budget's Sync ID (Settings → Show advanced settings → Sync ID)                                                                                                                                                                          |
| `ACTUAL_BUDGET_ENCRYPTION_PASSWORD` | no       | Only if the budget uses end-to-end encryption                                                                                                                                                                                               |
| `ACTUAL_DATA_DIR`                   | no       | Where the local copy of the budget lives. Default: a temp folder. Use a persistent folder (the Docker image uses `/data`)                                                                                                                   |
| `ACTUAL_MCP_READ_ONLY`              | no       | `1` hides every tool that can change data                                                                                                                                                                                                   |
| `MCP_TRANSPORT`                     | no       | `stdio` (default) or `http`. The `--stdio` / `--http` flags override it                                                                                                                                                                     |
| `MCP_HTTP_HOST`                     | no       | Address to listen on for `http`. Default `127.0.0.1`; the Docker image sets `0.0.0.0`                                                                                                                                                       |
| `MCP_HTTP_PORT`                     | no       | Port for `http`. Default `3600`                                                                                                                                                                                                             |
| `MCP_AUTH_TOKEN`                    | no       | If set (16+ characters), `/mcp` requires `Authorization: Bearer <token>`                                                                                                                                                                    |
| `MCP_ALLOWED_HOSTS`                 | no       | Comma-separated host names the `Host` header must match, to guard against DNS rebinding. Without it, a server listening on a loopback address accepts only loopback host names, and one listening elsewhere (such as `0.0.0.0`) accepts any |

A bad configuration prints every problem at once and exits.

The Actual sync server allows only a few failed logins per 15 minutes. After a
failed login (a wrong password or an unknown Sync ID), the MCP server therefore
waits five minutes before trying again, so a typo does not lock you out of
Actual's own screens; fix the setting and restart.

## Running it

From the repository root (`yarn` commands always run from the root):

```sh
yarn build:api                              # the API bundle the server loads
yarn workspace @actual-app/mcp-server build # bundles the server to dist/
```

- **stdio** (a client starts the process and talks over stdin/stdout):
  `node packages/mcp-server/dist/index.js`
- **HTTP**: `node packages/mcp-server/dist/index.js --http` serves MCP at
  `http://127.0.0.1:3600/mcp` and a health check at `/healthz`.
- **Docker**: see [Docker](#docker).

`yarn workspace @actual-app/mcp-server start` rebuilds the server bundle and
runs it over stdio.

Over HTTP the server keeps no session: each request is answered on its own,
and `GET`/`DELETE` on `/mcp` return 405. All tool calls share one Actual
session and run one at a time.

## Connecting clients

### Claude Code

Local, over stdio:

```sh
claude mcp add actual \
  --env ACTUAL_SERVER_URL=https://actual.example.ts.net \
  --env ACTUAL_SERVER_PASSWORD=... \
  --env ACTUAL_SYNC_ID=... \
  -- node /path/to/actual-budget/packages/mcp-server/dist/index.js
```

Remote, over HTTP (for example the deployment in `deploy/unraid`):

```sh
claude mcp add --transport http actual https://actual.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Leave `--header` out if no token is set.

### Claude Desktop

Use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) shim, which
runs on your own computer and so can reach a private tailnet address. In
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "actual": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://actual.<tailnet>.ts.net/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

(Drop the `--header` pair and the `env` entry if no token is set.)

A custom connector added in Claude Desktop's settings may instead be contacted
from Anthropic's servers rather than from your computer. If so, it cannot
reach a tailnet-only address, which is why the shim is the safer choice here.
Check Anthropic's current documentation for how your version behaves.

To run the server directly from Claude Desktop instead, point `command` at
`node` with `packages/mcp-server/dist/index.js` as the argument and the
`ACTUAL_*` variables in `env`.

## Docker

`docker/Dockerfile` builds the HTTP server image. The build context is the
repository root, and the bundles are built first, as CI does:

```sh
yarn build:api
yarn workspace @actual-app/mcp-server build
docker build -f packages/mcp-server/docker/Dockerfile -t actual-mcp .
docker run --rm -p 3600:3600 \
  -e ACTUAL_SERVER_URL=http://host.docker.internal:5006 \
  -e ACTUAL_SERVER_PASSWORD=... -e ACTUAL_SYNC_ID=... \
  -v actual-mcp-data:/data actual-mcp
```

The image runs as a non-root user, keeps the local budget in `/data`, and has
a health check on `/healthz`. It contains no configuration, so it is safe to
publish.

The Unraid deployment (an image built by CI on every push to `master`, updated
automatically, served over a private tailnet) is described in
[`deploy/unraid/README.md`](../../deploy/unraid/README.md).

## Development

```sh
yarn workspace @actual-app/mcp-server test        # unit and tool tests
yarn workspace @actual-app/mcp-server typecheck
```

Tests run the real `@actual-app/api` against a temporary budget; no sync
server is needed. The code is layered so features can be reused:

- `src/actual/` talks to Actual (sessions, lookups, import, reconcile)
- `src/analysis/` is pure computation on plain transactions
- `src/tools/` holds each tool's schema and a thin handler, grouped by area
- `src/transports/` serves the tools over stdio or HTTP

To add a tool, create a module under `src/tools/` with `defineTool` and add it
to `src/tools/index.ts`; `src/server.test.ts` then holds its description to
the same standard as the others.

Two things to know when working here:

- `yarn typecheck` from the root overwrites the API bundle in `packages/api/dist`
  with plain compiled output. Run `yarn build:api` again before starting the
  built server.
- The built server only starts if `@actual-app/api` is built, but the tests do
  not need it.
