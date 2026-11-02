# Deploy hardening: what the repo now does, and what the team must set up

Until now, anyone who could push a branch or dispatch a workflow could run
commands as root on the production droplet. The workflow changes below close
the part the repo controls; the GitHub and droplet steps close the rest.

## Done in the repo

- `.github/workflows/deploy.yml` deploys only from the `production` branch, and
  only a commit already on it. The `resolve` job refuses a run from any other
  branch, and a `ref` input that is not a commit SHA on `production`
  (`git merge-base --is-ancestor <sha> origin/production`). A rollback still
  works: dispatch the workflow on `production` with an older production SHA.
- The deploy job runs in the `production` GitHub Environment.
- Every job asks for the least token permission it needs (`permissions: {}` by
  default); `ci.yml` is read-only. Checkouts do not keep the token
  (`persist-credentials: false`), so install scripts and tests cannot read it.
- Actions are pinned to commit SHAs (the comment names the tag): checkout and
  setup-node v4.4.0, setup-buildx v3.12.0, login v3.7.0, build-push v6.19.2.
  Base images (node, postgres, redis, caddy, the Dockerfile syntax image) are
  pinned by digest.
- The root `docker-compose.yml` publishes Postgres and Redis on 127.0.0.1 only
  and refuses to start without `POSTGRES_PASSWORD`.

## GitHub settings (an admin, once)

1. **Settings › Environments › New environment `production`**:
   - Required reviewers: one or two people; tick "Prevent self-review".
   - Deployment branches and tags: "Selected branches and tags", add `production`.
   - Untick "Allow administrators to bypass configured protection rules".
   - Environment secrets: add `DROPLET_HOST`, `DROPLET_SSH_KEY` and
     `DROPLET_KNOWN_HOSTS` here.
2. **Settings › Secrets and variables › Actions**: delete the repository (and
   any organization) copies of the three `DROPLET_*` secrets. Until then, a
   workflow pushed on any branch can still read the key.
3. **Rotate the deploy key**: it was readable by every workflow until now. Make
   a new key pair, put the public half on the droplet (below), the private half
   in the environment secret, then remove the old public key from the droplet.
4. **Settings › Actions › General › Workflow permissions**: "Read repository
   contents and packages permissions", and untick "Allow GitHub Actions to
   create and approve pull requests".
5. **Branch ruleset on `production`**: require a pull request with an approving
   review, block force pushes and deletion, and limit who may bypass. Add a
   `CODEOWNERS` rule for `.github/workflows/` and `server/deploy/` so changes
   there need an owner's review.
6. Optional: let Dependabot keep the pins current. `.github/dependabot.yml`
   with `package-ecosystem: github-actions` (directory `/`) and `docker`
   (directories `/`, `/server`, `/client`), weekly.

Follow-up in the workflow: the build job still pushes the registry's
`:production` tag before the health check, so after a failed deploy the
registry names the bad build `production` (the droplet itself rolls back).
Push only `:<sha>` from CI and move `:production` after a healthy deploy.

## Droplet: a deploy user that can only deploy

Today CI logs in as root and runs whatever script the commit carries. Change
this in one sitting, together with the workflow change at the end:

```sh
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy     # docker is root-equivalent: the forced command below is the real limit
chown -R deploy:deploy /opt/crm
chown root:deploy /opt/crm/server/.env && chmod 640 /opt/crm/server/.env
# The read-only GitHub key that /opt/crm fetches with must be the deploy user's:
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh   # copy the key and known_hosts there
cp /opt/crm/server/deploy/deploy.sh /usr/local/lib/collabo-deploy.sh   # root-owned; update by hand when it changes
```

`/usr/local/bin/collabo-deploy` (root-owned, mode 755) accepts exactly
`deploy <40-hex sha> <github user>`, reads the GHCR token from stdin, and never
runs what the client sent:

```bash
#!/usr/bin/env bash
set -euo pipefail
read -r action sha user extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[[ $action == deploy && $sha =~ ^[0-9a-f]{40}$ && $user =~ ^[A-Za-z0-9-]{1,39}$ && -z ${extra:-} ]] \
  || { echo "usage: deploy <sha> <github user>" >&2; exit 2; }
git -C /opt/crm fetch --quiet origin production
git -C /opt/crm merge-base --is-ancestor "$sha" origin/production || { echo "not on production" >&2; exit 1; }
docker login ghcr.io -u "$user" --password-stdin
exec bash /usr/local/lib/collabo-deploy.sh "$sha"
```

In `/home/deploy/.ssh/authorized_keys` (one line, the new CI public key):

```
command="/usr/local/bin/collabo-deploy",restrict ssh-ed25519 AAAA... github-deploy
```

Then set `PermitRootLogin no` (or `prohibit-password` and remove the CI key from
`/root/.ssh/authorized_keys`) and reload sshd. In `deploy.yml`, set `User deploy`
in the SSH config and replace the two SSH steps with one:
`printf '%s' "$TOKEN" | $SSH "deploy ${{ needs.resolve.outputs.sha }} ${{ github.actor }}"`.

## Containers

**API as a non-root user.** The images still run as root. Switching to
`USER node` blindly would break uploads and chat media: the `uploads` and
`messaging_media` volumes hold root-owned files. Do it in this order:

1. In both runtime stages, before `CMD`: `RUN mkdir -p uploads storage/messaging && chown -R node:node uploads storage`
   (paths under the stage's `WORKDIR`), then `USER node`.
2. On the droplet, once, before deploying that image (volume names from
   `docker volume ls`, e.g. `server_uploads`):
   `docker run --rm -v server_uploads:/v -v server_messaging_media:/m alpine chown -R 1000:1000 /v /m`
3. Deploy, then upload a product image and receive a chat photo to confirm
   writes; `docker logs collabo-api` shows any `EACCES`.
   (Docker 20.10+ lets a non-root process bind port 80 in a container; the
   droplet uses 5000 anyway.)

**Redis append-only file.** `server/docker-compose.yml` is left without
`--appendonly yes` on purpose: a Redis that has only its snapshot and restarts
with that flag starts **empty**, losing every session, refresh token and queued
job: with the flag on, Redis loads only the append-only file, and there is
none yet. (Tried with a local Redis on 2026-10-28: a key saved in `dump.rdb`
was gone after a restart with `--appendonly yes`, and survived when AOF was
turned on live first.) To turn it on safely:

```sh
docker exec collabo-redis redis-cli CONFIG SET appendonly yes
docker exec collabo-redis redis-cli INFO persistence | grep -E 'aof_rewrite_in_progress|aof_last_bgrewrite_status'
# wait for aof_rewrite_in_progress:0 and aof_last_bgrewrite_status:ok, note DBSIZE, then add
#   command: redis-server --appendonly yes
# to the redis service and run: docker compose up -d redis   (DBSIZE should match)
```

**Root compose, existing installs.** `POSTGRES_PASSWORD` now has no default.
A database first started without it in `.env` has the old default password:
put `POSTGRES_PASSWORD=collabo_dev_password` in `.env` to start it, then set a
new one (`ALTER USER collabo PASSWORD '...'`) and update `.env` to match.

**Moving a pinned image.** Look up the tag's current digest, e.g.
`docker buildx imagetools inspect node:24-alpine` (the top-level `Digest`), and
replace the `@sha256:` part in every Dockerfile or compose file that uses it.
