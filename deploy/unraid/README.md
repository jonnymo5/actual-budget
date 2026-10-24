# Running Actual Budget on Unraid (wolverine)

Actual runs on the Unraid server as a Compose Manager stack, reachable only
over Tailscale at `https://actual.<tailnet>.ts.net`. Updates are hands-off:

```
push to master (jonnymo5/actual-budget)
  └─► GitHub Actions: .github/workflows/unraid-image.yml
        builds linux/amd64, boot-tests it, pushes
        ghcr.io/jonnymo5/actual-server:latest + :sha-<hash>
          └─► Watchtower on wolverine (ghcr.io/jonnymo5/watchtower, built from
              the jonnymo5/watchtower fork) notices the new :latest digest
              within 5 min, pulls it, and recreates actual-server
```

Never build the image locally on the Mac for wolverine — Apple Silicon
produces arm64 images.

The same stack also runs the MCP server (`actual-mcp`), which lets Claude work
with the budget at `https://actual.<tailnet>.ts.net/mcp`. It is built and
updated the same way, by `.github/workflows/unraid-mcp-image.yml`. See
[Adding the MCP server](#adding-the-mcp-server).

## Why HTTPS via Tailscale

Actual's web app needs a secure context (HTTPS) anywhere other than
`localhost`; over plain `http://wolverine.local:5006` it fails with a
SharedArrayBuffer error. A Tailscale sidecar gives Actual its own tailnet
machine (`actual`) with a real Let's Encrypt certificate, without exposing
anything to the internet or the LAN. Every device that uses Actual (Mac,
phone) needs the Tailscale app, signed in to the same tailnet.

The sidecar reaches Actual by container name (`http://actual-server:5006`)
over the stack's private Docker network; actual-server publishes no ports.
The same pattern works for any other app: add a tailscale service to its
stack and point the serve config's `Proxy` at that app's container and port.

## One-time setup

### 1. Tailscale admin console

In https://login.tailscale.com/admin:

1. **DNS** → enable **MagicDNS** and **HTTPS Certificates**.
2. **Access controls** → make sure a tag exists for containers, e.g.:

   ```json
   "tagOwners": { "tag:container": ["autogroup:admin"] }
   ```

3. **Settings → Keys** → **Generate auth key**: not reusable, **pre-approved**,
   tags: `tag:container`. Tagged devices don't have key expiry, so the node
   stays logged in. The key is only used for the first login.

### 2. GHCR image visibility

After the first successful run of `unraid-image`, open
https://github.com/users/jonnymo5/packages/container/actual-server/settings and
set visibility to **public** (the repo is public and MIT, so nothing changes by
publishing the image). Wolverine then pulls without a login.

Because anyone can pull it, **nothing environment-specific may ever go into
the image**: no hostnames, tokens, or data. Those belong in this compose file
and its `.env`.

### 3. Prepare storage on wolverine

```sh
mkdir -p /mnt/maincache/appdata/actual-budget/data /mnt/maincache/appdata/actual-budget/tailscale
chown -R 99:100 /mnt/maincache/appdata/actual-budget/data
```

In the Unraid UI, the `appdata` share should be **cache: only**. The compose
file mounts the direct `/mnt/maincache/...` paths on purpose — `/mnt/user/...`
goes through Unraid's FUSE layer, whose locking quirks don't mix with SQLite.

### 4. Start Watchtower

Watchtower is its own stack, shared by the whole server. Set it up first from
the watchtower fork: `deploy/unraid/README.md` in `jonnymo5/watchtower`.

### 5. Start Actual

With the **Compose Manager** plugin:

1. Add a new stack `actual-budget`; paste in `deploy/unraid/docker-compose.yml`.
2. In the stack's `.env`, set `TS_AUTHKEY=tskey-auth-...`.
3. Compose Up.
4. In the Tailscale admin console, the machine `actual` should appear. Open
   `https://actual.<tailnet>.ts.net` — the first request takes a few seconds
   while the certificate is issued.
5. Set the server password on first visit, then create or import a budget.

After the first login, delete `TS_AUTHKEY` from `.env`; Tailscale keeps its
login in `/mnt/maincache/appdata/actual-budget/tailscale`, and the stack starts
fine without the key. If that folder is ever lost, the container starts but
stays logged out (`docker logs actual-tailscale` shows `NeedsLogin`): generate
a new auth key, put it back in `.env`, and Compose Up.

## Adding the MCP server

`actual-mcp` ([`packages/mcp-server`](../../packages/mcp-server/README.md)) is
an MCP server that gives Claude Code and Claude Desktop access to the budget.
It runs in this stack, signs in to `actual-server` like any other Actual client
(over the private Docker network, by container name), and is published by the
existing tailscale container at `https://actual.<tailnet>.ts.net/mcp`. That is
the same tailnet machine, so there is no new Tailscale node, key or
certificate, and like Actual it publishes no ports.

If the stack is already running, do this once:

1. **Image.** After the first successful run of the `unraid-mcp-image` workflow
   (start it from the Actions tab if you don't want to wait for a push), open
   https://github.com/users/jonnymo5/packages/container/actual-mcp/settings and
   set visibility to **public**, for the same reason as in step 2 above: the
   image contains nothing environment-specific.
2. **Storage.**

   ```sh
   mkdir -p /mnt/maincache/appdata/actual-budget/mcp
   chown -R 99:100 /mnt/maincache/appdata/actual-budget/mcp
   ```

   This folder is only the server's local copy of the budget; the master copy
   stays in Actual's own data folder. It is disposable: if it is deleted, the
   server downloads the budget again on its next start.

3. **Settings.** Add these to the stack's `.env` (never commit it):

   ```sh
   ACTUAL_SERVER_PASSWORD=<the server password you set in Actual's web app>
   ACTUAL_SYNC_ID=<Settings → Show advanced settings → Sync ID>
   MCP_AUTH_TOKEN=<a random secret, e.g. from: openssl rand -hex 32>
   # Only if the budget uses end-to-end encryption:
   # ACTUAL_BUDGET_ENCRYPTION_PASSWORD=...
   # Hide every tool that can change the budget:
   # ACTUAL_MCP_READ_ONLY=1
   ```

   Without `MCP_AUTH_TOKEN`, anyone on the tailnet can read the budget and
   make changes through the server, so set one. (Changes need a second call
   with `dry_run: false` to apply, but that is a safety net against mistakes,
   not a defence against another user.)

4. **Start it.** Replace the stack's compose file with the updated
   `docker-compose.yml` and Compose Up. The tailscale container is recreated
   because its serve config gained the `/mcp` route (it stays logged in), and
   `actual-mcp` starts.
5. **Check it.** `docker ps` shows `actual-mcp` as healthy after a minute, and
   `docker logs actual-mcp` ends with `Listening on http://0.0.0.0:3600/mcp`.
   From a device on the tailnet, `curl -i https://actual.<tailnet>.ts.net/mcp`
   answers `401` (token set) or `405` (no token). Both prove the route works;
   a `404` or a timeout means the serve config did not update.
6. **Connect Claude.** See
   [Connecting clients](../../packages/mcp-server/README.md#connecting-clients).

If the container logs `... is required`, a value is missing from `.env`. If it
logs `Authentication failed`, the password or Sync ID is wrong; fix `.env` and
Compose Up. After a failed login the server waits five minutes before trying
again, to stay under Actual's login rate limit, so restart the container to
retry immediately.

## Day-2 operations

- **Update Actual**: push to `master` (or run the `unraid-image` workflow
  manually). Watchtower deploys it within 5 minutes. Watch it happen with
  `docker logs -f watchtower` on wolverine.
- **Pull in upstream changes**: when you want them,

  ```sh
  git fetch upstream && git merge upstream/master && git push origin master
  ```

  (one-time: `git remote add upstream https://github.com/actualbudget/actual.git`).
  The push triggers a build like any other.

- **Rollback**: Actual migrates its database on startup, so back up first (see
  below). Then pin the previous tag in the compose file —
  `image: ghcr.io/jonnymo5/actual-server:sha-<hash>` (tags are listed on the
  GHCR package page) — and Compose Up. Watchtower leaves pinned tags alone
  until you switch back to `:latest`.
- **Pause auto-updates**: set the actual-server label to
  `com.centurylinklabs.watchtower.enable=false` and Compose Up. The same label
  on `actual-mcp` pauses its updates separately.
- **MCP server**: updated by the same push and Watchtower flow, as the image
  `ghcr.io/jonnymo5/actual-mcp`. To roll back, pin
  `ghcr.io/jonnymo5/actual-mcp:sha-<hash>` in the compose file. To rotate the
  token, change `MCP_AUTH_TOKEN` in `.env`, Compose Up, and update the token in
  each Claude client's configuration.
- **Update Tailscale**: it is pinned by version and digest and never
  auto-updated. Bump the tag + digest in the compose file, then Compose Up.
  Only the tailscale container is recreated; Actual keeps running.
- **Backups**: cover `/mnt/maincache/appdata/actual-budget/data` with Unraid's
  appdata backup plugin. For a single budget, Actual can also export a zip
  from **Settings → Export data**.
- **Away from home**: nothing to do — the tailnet URL works anywhere Tailscale
  is connected. Do NOT port-forward or enable Funnel; the serve config
  explicitly disables Funnel.
