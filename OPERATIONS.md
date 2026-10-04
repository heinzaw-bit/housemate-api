# Production operations

## Progress — 2026-10-03 (Asia/Bangkok)

- Push is enabled in production. The user confirmed Android Chrome phone
  delivery and notification-tap opening after the 2026-10-03 web fix. iPhone
  Safari installation and delivery were reported with about a 30-second delay.
  Closed-app delivery/tap acceptance is still pending. Two recent Apple pushes
  were provider-accepted in about 45–48 seconds without errors; the every-minute
  scheduler is healthy. This timing does not demonstrate an iPhone defect.
- Sentry production owner alerts are configured and readback verified for API
  and web. Redacted synthetic new errors were accepted at 09:55:31–32; the web
  rule fired at 09:55:54 and API at 09:55:56. The user confirmed both owner test
  emails arrived. The regression path remains unverified. No application
  deployment or household write was needed.
- Web uptime job 8546967 was found disabled with status 6 (response too large).
  The landing page returned 200 but was 66,264 bytes. HEAD still failed at the
  provider; a small, no-store web-runtime `GET /api/health` endpoint replaces the
  landing page check. API readiness and the reminder schedule stayed healthy.
  The repaired web monitor recorded scheduled HTTP 200 at 08:20:03 (747 ms).
- Isolated scheduler alert job 8567732 verified scheduled HTTP 404 failure at
  08:10:36/08:11:02 and HTTP 200 recovery at 08:12:17/08:13:02. It was then
  deleted. Only owner-email alerts were enabled. The user subsequently confirmed
  failure/recovery emails and provided the failure screenshot. Sentry
  access/configuration and email receipt were also completed above.
- A fresh encrypted production backup was captured at 08:15:47: 66 tables,
  Storage object count zero. The existing key had an empty access list; native
  ACL tooling added Read permission only for its existing MSI\\ADMIN owner.
  Inheritance and access for other accounts were not enabled. The existing
  recovery key was retained.
- Its complete isolated restore passed at 08:25:04 in 16 seconds: all 66 table
  counts/digests, Auth identity references, RLS, dashboard/household isolation,
  financial edit/void history and managed-schema recovery SQL. Missing stdout
  options and omitted namespace creation in schema-filtered recovery SQL were
  fixed. Managed Supabase/Auth service cutover is still untested.
- Private DreamyDay Blob store `housemate-backups` in bom1 is connected only to
  API Development. The user approved reading its generated server token and
  provisioning private API GitHub Actions secrets for that token, the existing
  production database URL and the retained recovery key. No secret is in Git,
  the web client or Blob archives. `BACKUP_AUTOMATION_ENABLED=true` is verified.
- Initial cloud upload passed at 09:17:41; its Linux restore failed. The runner
  fix disables the system Unix socket directory and uses authenticated loopback
  TCP for the disposable cluster. API commit `5d28806` passed lint/typecheck,
  75 tests and build, plus clean CI 37089625330. The downloaded first archive
  passed a full local restore at 09:22:13 (66 tables).
- Cloud rerun 37089625945 succeeded: backup captured at 09:23:53, private access,
  download/decryption/checksum and retention verified, then full isolated restore
  passed at 09:25:11. All 66 table counts/digests, Auth references, RLS, financial
  API/history and managed-schema recovery SQL checks passed. Inventory is fresh:
  one 498,706-byte archive. Daily 03:17 Bangkok scheduling is enabled; the first
  scheduled run has not occurred yet. Saturday and manual runs include full
  restore checks. Managed Supabase/Auth cutover and email receipt remain untested.
- The user enabled GitHub Actions failure emails. Actual GitHub failure email
  receipt and the separate protected recovery-key copy remain pending.

## Verified state — 2026-10-01 (Asia/Bangkok)

- Production API and web Sentry variables are configured and deployed. Both
  projects accepted a synthetic redacted event with HTTP 200. Deployed browser
  assets contain the web DSN and privacy filter. A real browser crash and Sentry
  owner email delivery have not been exercised; enable issue/regression alerts.
- cron-job.org uptime jobs **8546966** (API) and **8546967** (web) run every five
  minutes. Their initial executions at 01:35:02 returned HTTP 200 in 208 ms and
  434 ms. Failure/recovery email settings are verified, actual delivery is not.
- An encrypted production backup was created at 00:46:40. The isolated custom
  archive restore completed at 00:51:58 in 17 seconds: all 65 table counts/digests,
  Auth references, RLS and three API/financial smoke checks passed. Production
  was read only. Storage object count was zero.
- The additional recovery-SQL phase was still pending on 2026-10-01. The latest
  2026-10-03 drill above completes it locally, without restoring broad inherited
  access. A managed Supabase cutover remains untested.
- Offsite backup storage, unattended backups and a managed Supabase cutover
  remain unconfigured or untested.

## Error reporting

Create `housemate-api` (Node.js) and `housemate-web` (Next.js) projects in Sentry.
Use the Developer plan unless a paid upgrade is approved. Save their write-only
DSNs in ignored `.env.monitoring` as `SENTRY_API_DSN` and `SENTRY_WEB_DSN`.
This is operator setup input, not automatically loaded runtime configuration.

Set production-only Vercel variables and redeploy:

| Project | Variable | Value |
| --- | --- | --- |
| API | `SENTRY_DSN` | API project DSN |
| Web | `SENTRY_DSN` | Web project DSN |
| Web | `NEXT_PUBLIC_SENTRY_DSN` | Web project DSN |

Reporting runs only in Vercel production. Keep automatic exposure of Vercel
system environment variables enabled for the web production guard/commit release.
Runtime reporting requires no Sentry auth token. Source map uploads are disabled until a private
build token/project setup is supplied; browser stacks refer to built chunks.
Never put a private Sentry auth token in `NEXT_PUBLIC_` variables.

API unexpected request errors, notification failures, idle DB errors and unhandled
Node errors are captured. Web browser errors/rejections, route/global render
failures and Next server request errors are captured. Normal validation/permission
failures and offline API calls are not reported. Both event policies discard raw
exception text, request bodies/URLs/headers, user/household data, tokens,
breadcrumbs, source context and local variables. They retain static stack
locations, error type, release and API operation. Tracing, replay and log upload
are disabled; API flushes are bounded to two seconds. Reporting failures do not
change financial confirmation outcomes.

### Owner alerts

The existing US `dreamyday` project rules were updated in place on 2026-10-03:

| Project | Alert | Linked issue monitor |
| --- | --- | --- |
| `housemate-api` | [HouseMate API: production errors](https://dreamyday.sentry.io/monitors/alerts/6093012/) | `10494760` |
| `housemate-web` | [HouseMate web: production errors](https://dreamyday.sentry.io/monitors/alerts/6093036/) | `10494807` |

Both rules are enabled and limited to `production`, with new-issue or regression
triggers, an error-or-fatal filter, and a direct email action to the active owner.
The repeat notification interval is 30 minutes per issue. Other organization
rules were preserved. Local operator access uses `SENTRY_AUTH_TOKEN` in ignored
`.env.monitoring`; keep it out of runtime/client variables, source and output.

Controlled synthetic errors passed through the actual independent API/web
sanitizers and were accepted with HTTP 200. At 09:55 Bangkok the rules' trigger
timestamps advanced after submission. API event `5e0da6ba584c453cba598a31458126a9`
and web event `10ba267ebda44fb290c1ceb3d5dec4f2` use synthetic verification frames
and contain no household records or raw private exception details. The user
confirmed both owner test emails arrived. Ingestion, triggering and inbox receipt
are verified; a real browser crash and the resolve/recur regression path remain
unverified. Resolve the synthetic test
issues after receipt. A later controlled recurrence can verify regressions
after the repeat interval; do not generate a new issue merely to repeat a
successful ingestion check.

No public crash-test route exists. Browser blockers/offline state or quotas can
prevent delivery. The Sentry agent plugin does not set app DSNs or deploy SDK code.

## Uptime

`npm run uptime:configure` reuses the cron-job.org key in ignored `.env.scheduler`.
It verifies targets, saves/reuses URL-matching jobs disabled, verifies settings,
then enables them. No job/database credentials are attached to uptime requests.

- API: `/health/ready`, read-only SELECT 1, five-second query/production connection
  timeout, no-store, only `ok` or `unavailable`. `/health` remains process liveness.
- Web: `/api/health`, checking the Next.js runtime through a small no-store
  response. This avoids the landing page exceeding the provider's size limit.
- Every five minutes, 30-second timeout, redirects fail, response storage off.
- Account-email alerts: first failure, recovery, automatic disablement and
  certificate expiry. Native alerts run independently of this computer.

`npm run uptime:status` checks status/settings and considers runs older than 15
minutes stale. It makes four management calls. The provider's default quota is
100/day; existing hourly reminder monitoring uses about 48/day. Avoid frequent
manual polling. Scheduled executions do not use that management quota. Native
email configuration is verifiable; actual email delivery requires an alert drill.
HTTP checks do not establish signed-in, browser JavaScript, Auth or phone health.

For failures: confirm the URL, inspect Vercel/Sentry and Supabase status, roll back
a faulty deployment when appropriate. Check saved financial records before any
write retry, preserving original idempotency keys. Investigate a disabled job
before re-enabling it. Update origins/check URLs after domain changes.

## Backup and restore

Supabase currently uses Free; managed daily backups are not assumed. Requires
Node 22+, dependencies, built API and PostgreSQL 17+ tools. Set `PG_BIN` to a
trusted bin directory. This Windows workspace defaults to ignored
`.run/tools/pg17/pgsql/bin` (official EDB 17.11 portable binaries).

```powershell
npm run backup:create
npm run backup:drill -- ".run/backups/housemate-TIMESTAMP.hmbak"
```

Creation uses ignored `.env.vercel`, verified TLS, and a read-only repeatable-read
transaction. A custom-format dump and table counts/content digests share its
exported snapshot. Includes `housemate`, `auth`, `storage` schema/data, constraints,
indexes, functions, RLS, sequences and audit history. No production writes or
migrations occur. The dump is bounded to 512 MiB and tool operations to five minutes;
larger deployments need streaming tooling.

AES-256-GCM encrypts the archive/manifest before writing; creation leaves no
plaintext dump. The first run generates `.run/keys/backup.key` (32 bytes).
`BACKUP_KEY_FILE` supports a separately protected location. Keep the key out of
Git and separate from offsite copies; losing it prevents recovery. On Windows,
restrict ACLs on the key, backup and drill directories to the operator account;
POSIX file modes alone do not set Windows ACLs.

The offsite destination is private Vercel Blob. Cloud credentials and daily
scheduling are active as of 2026-10-03; the first manual cloud run and downloaded
archive restore passed. Recovery point is the latest verified archive, not the
next scheduled time. Check `backup:offsite-status` for freshness.

### Daily encrypted offsite workflow

The private API repository's `.github/workflows/backup.yml` runs at 03:17 Bangkok
time (20:17 UTC). Scheduled starts can be delayed by GitHub. It checks out main
with pinned actions, installs/builds without production secrets, then uses only
these repository Actions secrets for the backup step:

| Secret | Source |
| --- | --- |
| `BACKUP_DATABASE_URL` | Existing production database connection |
| `BACKUP_RECOVERY_KEY_BASE64` | Base64 encoding of the existing 32-byte recovery key |
| `BACKUP_BLOB_READ_WRITE_TOKEN` | Dedicated private `housemate-backups` store token |

Provision secrets through a private operator session/stdin, never logs, chat,
command arguments, workflow YAML or Git. Approve that transfer separately. Keep
a separately protected recovery-key copy outside GitHub and Blob: loss of the
key prevents recovery. The key is not uploaded with the archive. Main-branch
workflow execution uses read-only repository permissions and serializes backups.

Only after secrets are verified, set repository variable
`BACKUP_AUTOMATION_ENABLED=true` and dispatch an initial run. Its first/manual
run and Saturday runs restore the **downloaded offsite** archive into a fresh
isolated PostgreSQL 17 cluster; production is never a restore target. Check the
workflow's success and sanitized restore report before calling activation done.
Enable GitHub Actions failure notifications in the owner's account; email
receipt and silently missed scheduled runs are not established by a green run.

### Manual operator checklist

1. In GitHub Settings → Notifications → System → Actions, enable Email and
   Only notify for failed workflows. Watch the private API repository as needed.
   The user confirmed enabling these settings on 2026-10-03; failure email
   receipt itself remains untested.
   See [GitHub's notification instructions](https://docs.github.com/en/enterprise-cloud%40latest/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).
2. Copy the existing `.run/keys/backup.key` into a password manager's encrypted
   attachment or another separately protected location outside this computer,
   GitHub and Blob. Preserve the exact file; do not regenerate or paste it into
   chat. Losing every key copy prevents decryption.
   In Windows File Explorer, open the API folder, type `.run\keys` after its path
   in the address bar, and copy `backup.key` (32 bytes). Store the exact file as
   an encrypted attachment outside this computer, or on an encrypted USB drive.
   Verify that the stored file can be downloaded/unlocked and its SHA-256 matches
   the original before calling preservation complete; keep the original in place.
3. The user confirmed the cron-job.org owner failure/recovery emails for the
   isolated test around 08:10–08:13 Bangkok on 2026-10-03. The failure screenshot
   corroborates receipt; recovery receipt is user-reported. Do not repeat the
   successful isolated test.
4. Both Sentry owner test emails from around 09:55–09:56 Bangkok on 2026-10-03
   were confirmed received. Resolve the synthetic issues after reviewing them;
   regression email acceptance remains separate. For future missing alerts,
   inspect the owner's Sentry email preferences before arranging another test.
5. iPhone delivery was reported with a roughly 30-second delay, compatible with
   the once-per-minute worker. Leave the installed app closed without signing
   out for 90 seconds after another member's new update; disable Focus,
   Scheduled Summary and household quiet hours for this test. Record system
   alert arrival and its tap destination. Closed-app/tap acceptance remains
   pending; Android was confirmed working.

Each run creates an encrypted archive with verified TLS and a read-only exported
snapshot, uploads privately without overwriting, downloads from origin, verifies
byte SHA-256/authenticated decryption/archive checksum, and checks that an
anonymous HEAD request is denied. Retention begins only after all checks pass.
It keeps the newest backup in each of seven daily, four weekly and three monthly
Bangkok-time buckets (overlapping points share one file, at most 14). Only strict
`housemate/production/v1/TIMESTAMP.hmbak` paths are eligible for removal. Foreign
objects are preserved and counted against the budget. The script refuses an
archive over 16 MiB or an upload that would exceed 256 MiB total, preserving
headroom below Hobby's included storage. If Storage objects appear, unattended
validation fails until object-byte backup is added.

Local operators use ignored `.env.backup` containing `BLOB_READ_WRITE_TOKEN`:

```powershell
npm run backup:offsite
npm run backup:offsite-status
npm run backup:offsite-drill
```

Status is read only and treats the latest archive as stale after 36 hours.
Cloud runs use `BACKUP_DATABASE_URL` and canonical `BACKUP_RECOVERY_KEY_BASE64`;
they never generate a new ephemeral recovery key. No archives, decrypted files
or recovery keys are uploaded as GitHub artifacts or caches.

### Repeatable owner-alert test

```powershell
npm run uptime:alert-start
# Wait for the next scheduled minute, then:
npm run uptime:alert-recover
# After a scheduled recovery:
npm run uptime:alert-cleanup
```

`uptime:alert-status` prints sanitized history. A uniquely named temporary job
targets an intentionally nonexistent API path (404) then public `/health` (200),
attaches no credentials, expires after one hour and is removed after verified
recovery. It never stops services or modifies the production reminder worker.
Provider states and configured email channels are evidence of the alert trigger,
not delivery to an inbox. Confirm failure and recovery emails separately.

### Tested local drill

Drills accept only an encrypted file, never a destination database URL. They
verify authenticated decryption/archive SHA-256, create a fresh loopback cluster
with a random password, restore in one transaction, compare all backed-up table
counts and content digests, check Auth references/RLS, then run actual dashboard,
balances, household isolation, financial edit/history and void/history smoke
checks. Recovery SQL is also executed locally against provisioned Auth/Storage
schemas with application data emptied, then all table digests are checked again.
The server stops in `finally`. Evidence is written to
`.run/restore-drills/<id>/report.json`.

Run monthly and after schema/backup changes. The stopped cluster, password and
logs contain private data; remove that exact drill directory after inspecting
the report and verifying its server stopped. Local recovery does not run Supabase
Auth, OAuth/email, managed extensions or production traffic cutover.

### New Supabase target recovery

1. Choose a known-good copy and separately retained key; run the drill. During a
   planned cutover pause writes/reminders and capture a final backup.
2. Create a **new** project on compatible Postgres/Auth/Storage schema versions.
   Verify its reference/hostname differs from production. Review extensions in
   the manifest. Never run this recovery against the existing production project.
3. Run `node scripts/backup.mjs unpack <file>` to write private `schema.sql`,
   `data.sql`, `manifest.json` under a new ignored `.run/recovery/<id>` directory.
   Unpack makes no database connection/write. The schema file includes only
   HouseMate DDL; Supabase already provisions managed Auth/Storage schemas.
4. Verify the new managed tables contain no application/user records. Privately
   set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` for the new target's
   session pooler/direct connection and `PGSSLMODE=verify-full`, `PGSSLROOTCERT`
   to its trusted CA. Never put a password in command arguments/history.
5. Restore with PostgreSQL `psql`, using the actual unpack directory:

```powershell
psql --single-transaction --set ON_ERROR_STOP=1 `
  --file ".run/recovery/ID/schema.sql" `
  --command "SET session_replication_role=replica" `
  --file ".run/recovery/ID/data.sql" `
  --command "SET session_replication_role=origin" `
  --command "REVOKE ALL ON SCHEMA housemate FROM PUBLIC, anon, authenticated, service_role"
```

6. Stop on managed-schema/version errors; never skip failing statements. Verify
   every manifest count/digest, foreign keys, private-table RLS, financial balances,
   history and household isolation. This managed recovery is a runbook; a new
   managed Supabase cutover has not been tested.
7. Restore Auth Site URL/redirects, OAuth/email configuration; update server-only
   API DB/Auth variables and public web Auth/API configuration. Redeploy both,
   require fresh sign-in and test two accounts before changing traffic/resuming
   reminders. Retain the old project/backup until acceptance passes.
8. Remove private decrypted files, clear temporary credentials, back up the
   accepted target and rerun the drill.

Excluded: Storage object bytes (currently zero objects), platform settings,
JWT/provider keys, custom role passwords, Vault keys, Edge Functions and offsite
retention. Add separate object/key backups before introducing uploads/Vault.
Application migrations are versioned in Git; no Supabase CLI migration-history
table is used. No paid plan/PITR was enabled.

References: [Supabase backups](https://supabase.com/docs/guides/platform/backups),
[logical restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[PostgreSQL binaries](https://www.enterprisedb.com/download-postgresql-binaries),
[Sentry setup](https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/),
[scheduler API](https://docs.cron-job.org/rest-api.html).
