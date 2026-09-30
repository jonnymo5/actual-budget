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
  `com.centurylinklabs.watchtower.enable=false` and Compose Up.
- **Update Tailscale**: it is pinned by version and digest and never
  auto-updated. Bump the tag + digest in the compose file, then Compose Up.
  Only the tailscale container is recreated; Actual keeps running.
- **Backups**: cover `/mnt/maincache/appdata/actual-budget/data` with Unraid's
  appdata backup plugin. For a single budget, Actual can also export a zip
  from **Settings → Export data**.
- **Away from home**: nothing to do — the tailnet URL works anywhere Tailscale
  is connected. Do NOT port-forward or enable Funnel; the serve config
  explicitly disables Funnel.
