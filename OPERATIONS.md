# Production operations

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
- The additional recovery-SQL phase below was added after that passing drill
  and has **not** completed. Windows ACL tightening prevents the Codex sandbox
  PostgreSQL process from accessing temporary drill files. Automatic approval
  review rejected restoring inherited permissions; narrower access to temporary
  restore folders awaits the user's approval. Key/backup ACLs remain restricted.
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
No Sentry auth token is required. Source map uploads are disabled until a private
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

Enable Sentry owner email alerts for new production issues/regressions. Validate
with a synthetic non-private error and confirm it appears in Issues. No public
crash-test route exists. Browser blockers/offline state or quotas can prevent
delivery. The Sentry agent plugin requires a Codex restart and does not set app
DSNs or deploy SDK code.

## Uptime

`npm run uptime:configure` reuses the cron-job.org key in ignored `.env.scheduler`.
It verifies targets, saves/reuses URL-matching jobs disabled, verifies settings,
then enables them. No job/database credentials are attached to uptime requests.

- API: `/health/ready`, read-only SELECT 1, five-second query/production connection
  timeout, no-store, only `ok` or `unavailable`. `/health` remains process liveness.
- Web: `/`, checking the actual public page's HTTP availability.
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

Copy encrypted backups to an approved offsite destination daily and before
migrations. Suggested retention: seven daily, four weekly, three monthly. No
offsite destination or unattended backup schedule is configured yet. Recovery
point is the last successful manual backup, with no automatic 24-hour guarantee.

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
