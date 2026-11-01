# Deploying the Cue backend

The owner's checklist for the first deploy, and what happens on every push after it. The backend is one Worker, `cue-api` (the API, the OAuth server and the
admin app as its static assets), with its D1 database, KV namespace, R2 buckets, Durable Objects, Workflows, Workers AI and Rate Limiting bindings, all declared in
`apps/api/cloudflare.config.ts`. `docs/backend.md` is the design.

Nothing here has been run against a real Cloudflare account: the spike and the pull requests build it, run it under `cf dev` and check it with
`cf deploy --dry-run`. The first deploy is where the remaining unknowns surface; they are listed at the end.

## What deploys when

- **`.github/workflows/deploy.yml`** runs on every push to `main` that touches `apps/api` (the Worker, its migrations and its prompts), `apps/admin`, `packages/contract`
  or what builds them, and on demand (Actions › Deploy backend › Run workflow). It installs, runs `vp check`, applies the D1 migrations, runs `cf deploy`, applies the
  migrations again (the first deploy creates the database, so there is nothing to apply before it), and checks that `/v1/openapi.json` answers. It does not run on forks.
- **`.github/workflows/release.yml`** builds `Cue.app` from `apps/mac` on every push to `main` and publishes a GitHub release. It never deploys.
- The Mac app is built with the backend's address stamped in. That address is kept in one place, **`apps/api/production-url.txt`**: the Worker uses it as its issuer
  (`PUBLIC_URL`) and `apps/mac/scripts/build.sh` puts it into `Info.plist` (`CueAPIURL`). `CUE_API_URL` still overrides it at run time.

## 0. Before anything: the address

The Worker is served on `https://cue.sands.red`, a custom domain on the account's `sands.red` zone, and only there (`workersDev: false`). The address is
`apps/api/production-url.txt`; `cloudflare.config.ts` publishes the Worker to its host (`domains`), and `cf deploy` makes the DNS record and the certificate. The OAuth
apps below, the token issuer and the Mac app all use it, so a new address is a commit to that file before anything else.

## 1. The Cloudflare API token

Cloudflare dashboard › My Profile › API Tokens › Create Token › Custom token, scoped to the one account:

| Scope | Permission | Used for |
|---|---|---|
| Account | Workers Scripts: Edit | the Worker, its versions, secrets, Durable Objects and Workflows |
| Account | Workers KV Storage: Edit | the denylist namespace |
| Account | Workers R2 Storage: Edit | the `cue-materials` and `cue-recordings` buckets |
| Account | D1: Edit | the `cue` database and its migrations |
| Account | Account Settings: Read | the account lookup `cf` does |
| User | User Details: Read | `cf auth whoami` |

The "Edit Cloudflare Workers" template has all of these (and more). Workers AI and Rate Limiting need no permission of their own: the bindings are part of the Worker.
If the first deploy answers a 403 naming a permission, add it and run again. Note the **Account ID** too (dashboard › Workers & Pages › the right-hand side).

```bash
export CLOUDFLARE_API_TOKEN=...      # the token
export CLOUDFLARE_ACCOUNT_ID=...     # the account id
pnpm install
(cd apps/api && ./node_modules/.bin/cf auth whoami)   # checks the token
```

## 2. The OAuth apps (sign-in with Google and GitHub)

Both use the callback `https://cue.sands.red/api/auth/callback/<provider>`. People sign in to the Mac app and to the admin through them; the app itself is
a client of the backend's own OAuth server, which needs nothing from you.

**Google** (console.cloud.google.com › APIs & Services › Credentials › Create credentials › OAuth client ID; configure the consent screen first, External, and add yourself as a
test user, or publish it):

- Application type: Web application.
- Authorized JavaScript origins: `https://cue.sands.red`
- Authorized redirect URIs: `https://cue.sands.red/api/auth/callback/google`
- Scopes: `openid`, `email`, `profile` (the defaults). Keep the client id and secret.

**GitHub** (github.com › Settings › Developer settings › OAuth Apps › New OAuth App):

- Homepage URL: `https://cue.sands.red`
- Authorization callback URL: `https://cue.sands.red/api/auth/callback/github`
- Generate a client secret. Keep the client id and secret. (The app asks for `read:user` and `user:email`.)

Only a provider-verified email may sign in, and only an invited one (or the owner's).

## 3. The Worker secrets

The Worker expects seven (the names are in `apps/api/cloudflare.config.ts`; the rest of its settings are plain variables there):

| Secret | What |
|---|---|
| `ANTHROPIC_API_KEY` | the owner's Anthropic key: the backend does all the AI work |
| `DEEPGRAM_API_KEY` | the owner's Deepgram key: live and recorded speech recognition |
| `BETTER_AUTH_SECRET` | signs sessions and tokens: `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from step 2 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from step 2 |

A Worker has to exist to take secrets, so for the **first deploy** hand them to `cf deploy` in a file kept outside the repository (and delete it afterwards):

```bash
umask 077
cat > /tmp/cue-secrets.env <<EOF
ANTHROPIC_API_KEY=...
DEEPGRAM_API_KEY=...
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
EOF
```

Later, change one with `cf` (it makes a new Worker version with the secret):

```bash
cd apps/api
./node_modules/.bin/cf workers secrets update ANTHROPIC_API_KEY --worker cue-api --text "$NEW_KEY"
./node_modules/.bin/cf workers secrets list --worker cue-api      # names only
```

Deploys from CI keep the secrets the Worker has. Never put one in the repository, the workflow or a chat.

## 4. `ADMIN_EMAILS`

The owner's address(es), comma-separated: always invited, and they get the `admin` role (the admin app at `/admin`). It is a Worker variable read from the environment
when the config is built, so it must be set wherever `cf deploy` runs:

- for CI: Settings › Secrets and variables › Actions › **Variables** › `ADMIN_EMAILS` (the workflow stops when it is empty, because nobody could use the admin);
- for the first deploy by hand: `export ADMIN_EMAILS=you@example.com`.

## 5. The first deploy, by hand

```bash
cd apps/api
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ADMIN_EMAILS=you@example.com
./node_modules/.bin/cf workers types
./node_modules/.bin/cf deploy --dry-run                              # builds and checks; uploads nothing
./node_modules/.bin/cf deploy --secrets-file /tmp/cue-secrets.env    # creates D1, KV and R2, uploads the Worker with its secrets
node scripts/migrate-remote.ts                                      # applies migrations/*.sql to the database `cf deploy` created
rm /tmp/cue-secrets.env
```

`cf deploy` provisions what the bindings need (`--provision` is its default): the `cue` D1 database, the denylist KV namespace and the two R2 buckets. The Durable Object
classes (`Call`, `Janitor`) and the `cue-notes` Workflow come with the Worker. If the migrations cannot find the database by name, give its id: `CUE_D1_ID=… node scripts/migrate-remote.ts`
(`cf d1 list` shows it).

Then give GitHub what the workflow needs (Settings › Secrets and variables › Actions): the **secrets** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, the **variable** `ADMIN_EMAILS`.
Later pushes to `main` that touch the backend deploy by themselves.

## 6. Invite the first person, and check it

The owner is always invited. Anyone else: Admin › Invites (below), or from the command line:

```bash
cd apps/api
node scripts/invite.ts --remote friend@example.com     # invite
node scripts/invite.ts --remote --list                 # who is invited
node scripts/invite.ts --remote friend@example.com --disable
```

Check, in this order:

1. `curl https://cue.sands.red/v1/openapi.json` answers a JSON document. (The Worker is up.)
2. Open `https://cue.sands.red/admin/`, sign in with Google and again with GitHub, as an owner. The admin loads (Overview, Users, Invites, Settings). A signed-in
   member who is not an owner sees "Not allowed". Invite the first person under Invites.
3. Build the Mac app (`apps/mac/scripts/build.sh` stamps the address in), start it, sign in. It lists your projects (none yet), and Settings › Account shows the plan and a usage bar.
4. Make a project, add a file, Start Cue and speak (or play a call): the transcript streams, questions get answers. Stop it: the notes appear with a summary.
5. Admin › Overview shows the cost of that call; Users › the person › Monthly limit changes what Settings › Account shows.

## Before you spend money: prices

`apps/api/src/pricing.ts` is the one table every `usage` row is priced by (Anthropic per million tokens, Deepgram per minute, with its speaker and keyterm add-ons). They are the
list prices of November 2026, from Anthropic's and Deepgram's pricing pages: **compare them with the first invoices, and again whenever a provider changes its prices**, because the
monthly limits enforce against them. The default limit is 20 USD a person (Admin › Settings).

## What a real deploy has not verified

The spike and the pull requests could not check these without a real account; look at them first when something is off.

- **The SPA fallback for asset requests.** The admin SPA is served with `notFoundHandling: single-page-application` and `runWorkerFirst` listing every prefix the Worker
  answers. Under `cf dev` an unlisted path gets Vite's 404; on Cloudflare an unlisted one gets `index.html`. Check that `/v1/…`, `/api/auth/…`, `/login`, `/consent`, `/.well-known/…`
  and `/admin/v1/…` reach the Worker (not the SPA) and that a reload on `/admin/users` shows the app.
- **`toMarkdown`.** PDF and Word materials go through Workers AI `toMarkdown` (the `AI` binding). Under `cf dev` a stand-in answers; no case has run the real one. Upload a PDF and a
  Word file and read their text in the project.
- **The Rate Limiting binding.** Two limiters (`RATE_LIMIT` 600 a minute, `RATE_LIMIT_COSTLY` 30 a minute, per user). `cf dev` enforces them locally; Cloudflare's are eventually consistent per
  location and their counters are not shared across them, so a limit is approximate. Their namespace ids (`4101`, `4102`) must be unique within the account.
- **Deepgram from Workers.** The Call Durable Object holds an outbound WebSocket per channel to `api.deepgram.com` (Nova-3, with `diarize`). Under `cf dev` it talks to a stand-in. Watch the first real call's
  logs (Workers › cue-api › Observability) for `speech` status events and reconnects.
- **The remote scripts.** `scripts/invite.ts --remote` and `scripts/migrate-remote.ts` find the database by name through `cf d1 list`; neither has run against a real account.
- **Workflows and Durable Object migrations on first upload**, the **custom domain** (its DNS record and certificate, made by `cf deploy`), the **sign-in on `cue.sands.red`** (cookies are `Secure`, set on that host) and **`cf deploy --provision`** creating the R2 buckets by name.
- **Prices** against the first invoices (above).

## Rolling back

`cf workers versions` lists versions and `cf workers deployments` the deployments of `cue-api`; the dashboard (Workers › cue-api › Deployments) rolls back to an earlier
one. The D1 migrations only go forward: a migration that breaks the old code is a reason to fix forward.
