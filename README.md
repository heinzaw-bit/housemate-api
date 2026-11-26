# HouseMate API

Independent Node.js/TypeScript API for the HouseMate web and future mobile clients, published as [heinzaw-bit/housemate-api](https://github.com/heinzaw-bit/housemate-api). This repository owns its dependencies, migrations, tests, CI, and [OpenAPI contract](openapi.yaml). The [whole-project repository](https://github.com/heinzaw-bit/housemate) includes it as the `api/` submodule alongside the independent web app.

Shared product scope and engineering context live in the umbrella's [SPEC](https://github.com/heinzaw-bit/housemate/blob/main/SPEC.md) and [handoff](https://github.com/heinzaw-bit/housemate/blob/main/PROJECT_HANDOFF.md). Local `AGENTS.md` preserves the shared engineering boundaries; `api/openapi.yaml` in those workspace rules means `openapi.yaml` when this repository is cloned alone. Run the commands below from this repository root. No sibling checkout is required.

## Implemented slice

- `GET /v1/households/{id}/assistant` and `POST /assistant/questions` for authorized household Q&A. Quick topics work without AI configuration; typed questions support local greetings/app explanations, authorized announcement reads, general-information replies from Gemini, combined Board announcements/events and Catch me up for important notices, upcoming events and due bills. Household/financial answers use existing authorized services. Availability adds `chatEnabled` for local chat even without Gemini. The additive `POST /assistant/drafts` endpoint prepares local meal/announcement drafts without provider calls, writes or persisted drafts; availability exposes `actionDraftsEnabled`. Review/edit/confirm in the client, then use the existing idempotent meal/announcement endpoints. Recognized unsupported/multiple/negated commands do not fall back to Gemini. No separate assistant mutation endpoint or migration is added.

## Optional natural-language questions

Quick household topics, greetings, app explanations and common typed household questions need no provider setup. For general Gemini questions:

1. Run `npm run migrate:assistant` once with the configured private database connection, then `npm run smoke:assistant`. The latter uses a rollback-only transaction and makes no provider requests.
2. In [Google AI Studio](https://aistudio.google.com/api-keys), create a key in a project whose Billing Tier is **Free Tier**, with billing disabled. Save `GEMINI_API_KEY` in ignored API `.env` locally, or as a **Sensitive, Production** variable on Vercel's **housemate-api** project. Never put it in the web project, `NEXT_PUBLIC_`, Git, logs or chat.
3. After checking the Google project tier, set `GEMINI_FREE_TIER_CONFIRMED=true` on the API. This is an operator acknowledgement; HouseMate cannot verify Google's billing settings from a key. Keeping the Google project on Free Tier is what prevents paid usage. The fixed model is `gemini-3.1-flash-lite`; there is no retry or alternate paid provider/model.
4. Restart the local API or redeploy the API project. While signed in, check a household answer against its source page, then explicitly ask a non-sensitive everyday question such as “How should I store dry rice?” to verify Gemini. Common balance/Board questions are answered locally and do not exercise Gemini. Named-member questions belong in Money.

Only a non-sensitive typed question is sent to Gemini when local interpretation cannot answer it. The API validates its allowlisted classification and bounded general reply; household answers are built from authorized services; household records, member lists, balances and earlier answers never go to Google. HouseMate stores no prompts or conversation history. Google's [unpaid-service terms](https://ai.google.dev/gemini-api/terms) allow content use to improve products and human review, and prohibit submitting personal, sensitive or confidential information. The API retains its privacyAcknowledged request requirement for compatibility; the current web supplies it on explicit submission without an acknowledgement UI. The API also rejects known active-member names/emails, digits, links and credential markers before spending budget. This limited guard is not a complete personal-information detector, so members must keep other private details out too. Quick questions use HouseMate directly and need no acknowledgement.

Requests have a 12-second provider timeout, 800 output-token cap, no automatic retry, 20 attempts per account per UTC hour and 200 globally per UTC day. These are HouseMate limits, not a guarantee of Google's available free quota; provider 429 errors offer quick questions with no paid fallback. Failed/cancelled attempts can consume a slot. Private counters expire and are cleaned on the next AI request. Missing keys or free-tier confirmation, provider errors and exhausted budgets leave quick questions and manual flows available. Migration 016 is unchanged. Local greetings, app explanations, common household questions and allowlisted short follow-ups consume no provider slots. The draft API remains for older clients; the current web Assistant does not expose it.

Weather lookup has been removed; weather requests receive local clarification without provider use or a city prompt. The optional question `context` contains only an allowlisted previous topic, never messages/answers, IDs or financial details. Exact short household follow-ups are resolved locally (for example Today after events/Board); other questions still go independently through privacy checks and bounded classification. Context grants no access and is never sent to Gemini. Responses may contain up to three read-only clarification `choices`. Existing clients can omit both additions. Deploy this contract/API before clients using Board/context/choices.

## Household search

`GET /v1/households/{id}/search?q=rent&type=all&limit=20` returns authorized `results` and `nextCursor`. The concrete fields and limits are in OpenAPI. Nine saved record types are searchable with case-insensitive literal substrings in titles/descriptive text, including past/closed/voided states. Financial source histories, drafts, member emails, fuzzy matching and provider calls are excluded. Newest creation/publication first; cursor ties preserve microseconds and bind to caller, household, normalized query and type. A record link uses the normal authorized detail route.

Targeted announcements/polls follow the same author/audience/moderator rules as detail reads. Each call checks active membership in a read-only transaction, using existing household indexes, bounded page size and a five-second statement timeout. No schema migration or search provider credentials are needed. Household-scoped substring scans are appropriate for the current small-household release; large datasets may need indexed search after measuring query plans. API request URL logging is disabled; queries/results are no-store. `npm run smoke:search` uses isolated fixtures in an outer rollback transaction (two existing users required), prints only sanitized checks and makes no provider calls or lasting household changes.

## Other implemented endpoints

- Personal `GET /v1/households/{id}/notifications`, individual read and bounded read-all, and `GET`/`PUT /notification-preferences`. All feed and preference operations enforce active membership and caller ownership. Stable cursor pages preserve PostgreSQL timestamp precision.
- Authenticated `/v1/push-config` and account-owned `/v1/push-subscriptions` registration/list/removal. Server-generated transactional activity, scheduled reminders, and durable push delivery respect current membership, source state, preferences, read state, quiet hours, and device opt-in.
- `GET /v1/households/{id}/dashboard` for an authorized, consistent dashboard snapshot (personal/household balances, pending bills ordered by urgency, recent financial activity, and the next upcoming meal).
- `GET /v1/households/{id}/house-actions` for an authorized, uncached preview of the current member's unanswered meal checks, swap requests, assigned chores and shopping, announcements needing acknowledgement, and polls needing a vote. Each category returns up to three items.
- `GET` and `POST /v1/households/{id}/announcements`, item `GET`, and `PUT /acknowledgement` for targeted Normal/Important/Urgent posts, optional expiry, and permanent acknowledgement timestamps.
- `GET` and `POST /v1/households/{id}/polls`, item `GET`, and `PUT /vote` for targeted single/multiple choice polls with deadlines, aggregate results, and atomic vote replacement or withdrawal.
- `GET` and `POST /v1/households/{id}/meals`, `GET /v1/households/{id}/meals/{mealId}`, `PATCH /response`, and `PUT /cooking-roles` for meal checks, attendance, and cooking assignments.
- `GET` and `POST /v1/households/{id}/shopping-items`, item `GET` and `PATCH`, and item `/cancel`, `/purchase`, and `/purchase-with-expense` actions for the shared shopping list.
- `GET` and `POST /v1/households/{id}/chores`, item `GET`, and assignment, complete, skip, and swap request/response actions for one-off chores.
- `GET /health`
- `GET /v1/me`
- `PATCH /v1/me` for display name
- `POST /v1/households`
- `GET /v1/households`
- `GET /v1/households/{id}`
- `PATCH /v1/households/{id}` for name, timezone, and unlocked currency
- `GET /v1/households/{id}/members` and `PATCH /v1/households/{id}/members/{memberId}`
- `GET` and `POST /v1/households/{id}/invites`, plus `DELETE /v1/households/{id}/invites/{inviteId}`
- `GET /v1/invites/{token}` and `POST /v1/invites/{token}/accept`
- `GET /v1/households/{id}/expenses` and `GET /v1/households/{id}/expenses/{expenseId}`
- `POST /v1/households/{id}/expenses/preview` and `POST /v1/households/{id}/expenses`
- `GET /v1/households/{id}/bills` and `GET /v1/households/{id}/bills/{billId}`
- `POST /v1/households/{id}/bills/preview` and `POST /v1/households/{id}/bills`
- `PATCH /v1/households/{id}/bills/{billId}/status`
- `POST /v1/households/{id}/expenses/{expenseId}/edit-preview` and `PATCH /v1/households/{id}/expenses/{expenseId}`
- `POST /v1/households/{id}/bills/{billId}/edit-preview` and `PATCH /v1/households/{id}/bills/{billId}`
- `POST /v1/households/{id}/expenses/{expenseId}/void-preview` and `POST /v1/households/{id}/expenses/{expenseId}/void` (same pattern for bills)
- `GET /v1/households/{id}/expenses/{expenseId}/history` and `GET /v1/households/{id}/bills/{billId}/history`
- `GET /v1/households/{id}/balances` and `GET /v1/households/{id}/balances/{memberId}/entries`
- `POST /v1/households/{id}/settlements/preview` and `POST /v1/households/{id}/settlements`
- `GET /v1/households/{id}/settlements` and `GET /v1/households/{id}/settlements/{settlementId}`

Protected routes accept a Supabase access token in `Authorization: Bearer <token>`. The API checks that token with Supabase Auth. Household reads and writes are scoped to active membership. Owners and admins can invite; only owners can change roles or currency. Invitations expire after seven days, work once, and store only a SHA-256 token hash. The redeeming user can safely retry acceptance. Any active member can add an expense. The API calculates equal, exact, percentage, and ratio shares in integer minor units; participants may be a selected subset of active members. A confirmation uses a UUID idempotency key so a retry with the same draft returns the original expense. The first confirmed expense or saved shopping price locks household currency in the same database transaction.

Any active member can also add a bill. The bill API reserves explicitly classified individual or shared charges, applies credits to named recipients, then splits the remaining base amount equally among selected participants. Its preview rejects ambiguous adjustments, invalid members, negative final shares, and totals that cannot balance. Confirmation is idempotent and locks household currency. The bill-level Unpaid/Paid status records whether the provider was paid outside HouseMate; changes are audited in `bill_status_events`. It does not track per-member repayment or process payments.

Balance members return `expectedNetMinor`, the combined displayed balance:
confirmed `netMinor` plus each Unpaid bill’s full total for its planned payer,
minus the member’s Unpaid bill shares. All bills are household-scoped and voided
records are excluded. Marking a bill Paid leaves the combined amount unchanged.
`netMinor`, ledger entries and settlement previews/suggestions keep their confirmed
basis. `pendingBillShareMinor` remains available for older clients. Both additive
fields are optional in the contract for older API compatibility; no migration is
required. Void previews add `expectedBalanceEffects` for the combined displayed
before/after amounts while retaining confirmed `balanceEffects`.
`npm run smoke:settlements` verifies two members’ views, zero-sum
planned-payer allocations, Paid/Unpaid continuity and a planned payer outside the
split inside a rolled-back transaction.

Balances combine confirmed expenses, **Paid** bills, and recorded manual transfers. An Unpaid bill stays pending and does not affect member balances until marked Paid. Positive net amounts are owed to a member; negative amounts are what the member owes. The per-member entries endpoint lists the source amounts and their signed balance effects. Settlement suggestions are informational. Only the active household owner can preview and record transfers they sent or received outside HouseMate. All active household members can read those records. The API warns when a custom amount exceeds the suggested amount. Confirmation uses an idempotency key and stores who recorded the transfer and when. HouseMate does not process or verify payments.

The creator or an active household owner or admin can edit an expense. Only active household owners and admins can edit, void, or change the payment status of a saved bill. Regular members can create and read bills. The edit preview recalculates shares and returns a ten-minute preview ID tied to the exact draft and record revision. Confirmation requires that preview ID, the expected revision, and an idempotency key. A changed record or expired preview returns a conflict that calls for a fresh preview. Each edit stores before/after snapshots in `financial_edit_events`. Bill payment status remains on the separate status endpoint and advances the bill revision when changed.

Expense voids require the same creator or manager permission as expense edits. The API previews exact member balance changes for an expense or Paid bill, or the pending-total change for an Unpaid bill. Confirmation uses a ten-minute preview ID, record revision, and idempotency key. A voided record stays in lists with actor, time, and optional reason, but can no longer be edited or have its payment status changed. Voided shares are excluded from active balances; previously recorded settlements remain. The before/after void snapshots are stored in `financial_edit_events` with action `void`.

Any active member can read a record's paginated history. The API combines its original creation, edit and void snapshots, and bill provider-status events into entries with actor, time, and human-readable changed fields with old and new values. History checks active household membership and scopes the record ID to that household. Recorded manual transfers remain available through the settlement history endpoint.

Any active member can create a meal check and assign cooking roles to selected active participants. The API interprets meal time and response deadline in the household timezone and rejects invalid or past deadlines. Only selected active members can answer, and their answers lock at the deadline. Creation is idempotent. Meal records stay in the private schema and every read or write checks active household membership.

Any active member can create a future event with optional details, location, and end time. The API interprets times in the household timezone. Active members can read upcoming and past events and change only their own Going, Maybe, or Not going attendance until the event starts. Creation is idempotent, and every event operation checks active household membership. The event detail supplies current Going members for an optional expense draft suggestion; the normal expense preview and confirmation remain authoritative.

Any active member can publish announcements and polls to selected active members. Recipients/voters, the author, and active owners/admins may read them. Published content and audience stay fixed. Announcements support optional acknowledgement and expiry; only selected active recipients can acknowledge as themselves, and retries retain the original timestamp. Polls require 2–10 distinct options and a future deadline. Only selected active voters can replace or withdraw their own selections before that deadline. Aggregate results include previous votes from departed members. Transactions and database constraints prevent duplicate votes, multiple selections in a single-choice poll, and foreign-poll options. Publication uses scoped idempotency keys.

Any active member can create a one-off chore due in the household timezone for an active member. The assignee or an owner/admin can complete it or skip with a required reason. An assignee can ask another active member to take the chore; that member accepts or declines. Owners/admins can directly reassign, which cancels a pending swap. The API checks active membership, household scope, permission, and the chore revision for every change. The dashboard includes live open and overdue chore counts and the next due chore. Recurrence remains an open product decision.

Any active member can add, edit, assign, cancel, or purchase an open shopping item. Items have optional quantity, note, and prices in integer minor units with an explicit currency. The first saved shopping price locks household currency. Purchased and cancelled items remain visible but cannot be changed again. The `/purchase-with-expense` route uses the normal expense calculation, confirms the expense and purchase in one database transaction, and links the item to the expense. It accepts the same UUID retry key as an expense confirmation; a repeat with identical details returns the original result. Marking purchased without an expense does not change balances. Every shopping operation checks active household membership; changes to an existing item require its current revision.

## Local setup

1. Create a Supabase project and obtain its URL, publishable key, and a PostgreSQL connection URL for a trusted server. Do not place the database URL in a web or mobile client.
2. Copy `.env.example` to `.env` and fill in the values. Set `WEB_ORIGINS` to the exact browser app origin or a comma-separated list of allowed origins. Mobile requests do not need CORS.
3. Apply `sql/001_household_foundation.sql`, then `sql/002_member_onboarding.sql` to the Supabase database with a privileged migration connection. Run `npm run migrate:expenses`, `npm run migrate:bills`, `npm run migrate:settlements`, `npm run migrate:edits`, `npm run migrate:voids`, `npm run migrate:meals`, `npm run migrate:shopping`, `npm run migrate:shopping-currency`, `npm run migrate:chores`, `npm run migrate:events`, `npm run migrate:announcements-polls`, `npm run migrate:notifications`, then `npm run migrate:assistant` in that order to apply SQL files 003–016. Follow with `npm run migrate:action-create` for the additive shopping/chore retry migration. The notification runner applies 014 once and reapplies the safe function correction in 015. The schema is private and is not exposed through Supabase's Data API. Never run migrations during normal requests.
4. Run `npm ci` and `npm run dev` in this directory. The development command builds once and starts the API; restart it after changing API code or adding endpoints. If the web app says a feature needs a newer HouseMate API, restart this command and refresh the page.

`npm run lint`, `npm run build`, `npm run typecheck`, and `npm test` check the code. `npm run smoke:expenses`, `npm run smoke:bills`, `npm run smoke:settlements`, `npm run smoke:edits`, and `npm run smoke:voids` exercise the configured database inside transactions that are rolled back. The edit and void checks cover history values, unauthorized actions, foreign-household IDs, previews, idempotency, audit snapshots, and balances. The same standard checks run in `.github/workflows/ci.yml` when this directory becomes its own repository. `npm start` runs compiled output with environment variables supplied by the host.

`npm run smoke:meals` checks meal creation, safe retry, responses, cooking roles, the dashboard's next meal, deadline enforcement, and household isolation. Its fixture is rolled back.

`npm run smoke:events` checks event creation, retry safety, attendance changes, the start-time lock, and household isolation. Its fixture is rolled back.

`npm run smoke:announcements-polls` checks publication retries, targeted privacy, acknowledgement timestamps and expiry, vote replacement and withdrawal, single/multiple choices, database constraints, departed members, deadlines, personal House actions, and RLS. It uses an isolated household fixture and rolls it back.

`npm run smoke:shopping` checks item creation, editing, assignment, cancellation, purchases with and without expenses, atomic linking, retry safety, balances, the dashboard count, and household isolation. Its fixtures are rolled back.

`npm run smoke:house-actions` checks the personal House action preview for meal replies, swap requests, assigned chores, and assigned shopping; it also checks that closed items disappear and that foreign users cannot read the summary. Its fixtures are rolled back.

## Contract and deployment

See [production operations](OPERATIONS.md) for Sentry setup, public database
readiness, uptime alerts, encrypted backups, tested isolated restore drills and
the new-project recovery runbook. `npm run uptime:plan|uptime:configure|uptime:status`
manages public HTTP checks; `npm run backup:create` and `npm run backup:drill -- <file>`
never restore into production. Offsite backup scheduling is active and its first
cloud upload/restore passed on 2026-10-03. Sentry reporting and production owner
alerts are active; synthetic new-error triggering and actual owner email receipt
passed. A resolved-issue regression test still needs acceptance.

`openapi.yaml` describes the implemented endpoints. Clients should pin a compatible contract version. Production deployments must set `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`, terminate TLS at the edge, and allow the API to reach Supabase Auth and PostgreSQL. Never expose the database connection URL or an administrative key to a client.

See [manual Vercel deployment](DEPLOYMENT.md) for the prepared Fastify entry point, verified database TLS, required `CRON_SECRET`, and Hobby-compatible external notification scheduling. `src/application.ts` is the injectable route factory; `src/runtime.ts` wires production dependencies; `src/app.ts` is Vercel's detected server entry point; `src/main.ts` retains local/persistent-host startup. Vercel does not run a background interval. Its warm instances share a module-level pool capped at one connection, with a five-second connection timeout and verified TLS. The user's public Supabase CA is bundled in `src/supabase-ca.ts` alongside the standard trusted roots, so the current pooler needs no extra CA environment variable. Optional `DATABASE_SSL_CA` overrides the trust bundle for a future/custom host. URL SSL flags cannot disable verification. Neither entry point runs database migrations.

Expense, bill, and shopping lists return up to 100 records per request with `limit` and `offset`; source entries and settlement history are paginated too. Meal, event, announcement, and poll lists return up to 50 records per page with `limit` and `offset`. Meals support `scope=reply|upcoming|past`; events support `scope=upcoming|past`; announcements support `scope=all|needs_ack|expired`; polls support `scope=open|needs_vote|closed`. Details are in the root `SPEC.md` and domain documents.

## Notifications and optional web push

Migration 014 adds four private RLS-enabled tables: recipient notifications, member preferences, account browser subscriptions, and push deliveries. Invoker trigger functions create feed entries in the same transaction as the originating household action. Migration 015 fixes a trigger variable/column naming conflict found during database verification. Never run migrations during requests.

On local/persistent hosts, the API runs the notification worker at startup and every 60 seconds, including when push is unconfigured. On Vercel, schedule `GET /internal/notifications/run` every minute through an external scheduler with `Authorization: Bearer <CRON_SECRET>`; the user selected Hobby plus external scheduling. `npm run scheduler:plan`, `scheduler:configure`, and `scheduler:status` provide redacted cron-job.org setup and read-only monitoring; see [scheduler setup](DEPLOYMENT.md#repeatable-setup-and-status-commands) for private configuration, account-email failure/recovery/disablement alerts, actual scheduled-run verification, and recovery steps. No Vercel cron is configured, so Hobby imports do not fail its once-daily cron limit. Missing/invalid job credentials fail closed, member JWTs do not authorize jobs, and responses never contain household data. Overlapping calls on the same instance return 503 with Retry-After 60; failed batches return a sanitized 503 for scheduler monitoring/retry. Deterministic event keys deduplicate reminder phases. Delivery uses atomic `SKIP LOCKED` claims, expiring leases, bounded retries, and sanitized error codes. Multiple instances can share the queue. Provider 404/410 disables a subscription. Quiet hours delay every priority; current access, preferences, read state, expiry, and response/completion state are rechecked before sending. There is no guarantee that a provider-accepted push reaches a device, and retries can repeat a provider-accepted message; topics and service-worker tags coalesce duplicates.

To enable optional web push:

1. Run `npm run push:keys` once. It adds a VAPID keypair to ignored `.env` without printing private values or replacing an existing pair.
2. Set `VAPID_SUBJECT` to a real public `mailto:` contact or HTTPS support URL that you control, and keep `VAPID_PRIVATE_KEY` on the API only. The API exposes only the public key to authenticated clients. Do not invent a contact or use localhost as the contact URL.
3. Restart the API, then use Notifications → Settings → Enable push in this browser. Production web requires HTTPS. Some mobile browsers require installing the PWA. Allow API outbound access to the supported browser push providers (Google, Mozilla, Apple, Windows).

Without a complete VAPID/contact configuration, `/v1/push-config` reports disabled and device registration returns 503. Production push was configured and activated on 2026-10-02 using the user-provided contact and existing VAPID pair; each browser still requires explicit opt-in. Private local configuration was synchronized without exposing values. Inbox, preferences, and reminder generation remain active. Lock-screen text is generic and contains no amounts, household names, or private messages. Devices belong to one account across households; new opt-in does not replay old notifications. Existing subscriptions refresh on a signed-in visit, but a missing or disabled subscription requires explicit Enable again. Native mobile push, email, SMS, and LINE providers are not implemented.

`npm run smoke:notifications` uses an isolated transaction and simulated push transport to check recipient privacy, retry deduplication, read ownership, cursor precision, preferences, deadline reminders, device ownership, quiet deferral, disabling, invalid-subscription handling, and RLS, then rolls back. It never contacts a browser push service. Actual device delivery still needs checking after each browser explicitly opts in; production setup alone is not delivery evidence.

## Dashboard verification

Run `npm run smoke:dashboard` with the configured `DATABASE_URL`. It uses two existing signed-in users, creates isolated fixtures inside a transaction, and always rolls them back. It checks USD/THB totals, household timezone due boundaries, Paid/void exclusions, edits and reported transfers, more than 50 pending bills, stable activity ordering, and access isolation. No real household financial record is changed.

## Additional Assistant action drafts

The assistant prepares local unsaved shopping, chore, expense and hybrid-bill drafts alongside meals/announcements. New clients send `allowedKinds` to opt in (omission preserves older meal/announcement-only behavior); availability advertises `supportedDraftKinds`. No action request/member list is sent to Gemini, and preparation saves nothing. Named people and ambiguous amounts/dates need explicit editing; money allocation always uses the existing deterministic preview endpoints. Confirm through normal protected creation endpoints, not a separate AI execution service.

Before releasing this API, run `npm run migrate:action-create` against the intended database using its private environment. It applies the CLI-generated `supabase/migrations/20261001180100_action_create_idempotency.sql` once in a transaction with a bounded lock timeout, rejects partially applied columns and leaves existing records/permissions/RLS intact. Shopping/chore create requests accept an optional `idempotencyKey`; identical household/creator/key/payload retries return the current record, changed input returns 409, and legacy keyless requests remain valid. Existing actor/time/ID and immutable key/hash are the execution trace. Notifications fire only for the original insert. Release API before web. This migration was applied to the configured production database on 2026-10-02.

`npm run smoke:assistant-create` verifies the migration and shopping/chore repositories against empty isolated copies in a temporary schema, rolls everything back, and never changes production household data/schema or invokes notification/provider workers. It checks retry/conflict scope, single creation side effects, current state after edits, legacy callers, active members and creator/time/hash evidence. It does not claim live notification delivery or real parallel-request/device acceptance. Existing financial tests verify deterministic allocation; client tests verify that preview precedes explicit confirmation.
## Offsite backups and alert drills

See [OPERATIONS.md](OPERATIONS.md) for the private Vercel Blob backup workflow,
daily 03:17 Asia/Bangkok schedule, seven daily/four weekly/three monthly
retention and isolated weekly restore checks. Activation requires separately
provisioned GitHub Actions secrets and `BACKUP_AUTOMATION_ENABLED=true`.
Those approved secrets and the activation flag are configured as of 2026-10-03;
cloud run 37089625945 passed upload, verified private download and full 66-table
isolated restore. The first scheduled run and owner alert email receipt remain
separate checks. Follow the manual operator checklist in OPERATIONS.md.

`npm run backup:offsite`, `backup:offsite-status`, and `backup:offsite-drill`
support local operator runs. `npm run uptime:status -- --history` prints only
sanitized execution metadata. The `uptime:alert-start`, `uptime:alert-recover`,
`uptime:alert-status` and `uptime:alert-cleanup` commands exercise owner failure
and recovery alerts through a temporary job without interrupting production.
Provider configuration and scheduled outcomes do not prove email receipt.

## Timely notifications

Record saves immediately wake the durable queue using Vercel background tasks; the minute scheduler remains recovery/reminder generation. Apply additive `sql/017_notification_delivery.sql` before releasing this API: build, then run `node --env-file=.env.vercel scripts/apply-notification-delivery-migration.mjs` using ignored production configuration. Existing RLS and subscriptions remain.

The documented owned-device test endpoint requires active membership, has a persistent one-minute cooldown, bypasses quiet hours only for an explicit test, and never automatically retries. Acceptance is not phone receipt. Private `/internal/notifications/health` returns aggregate timing without draining. Scheduled runs return 503 for overdue queues/repeated failures, using current owner-email alerts plus sanitized Sentry reporting. See OPERATIONS.md.
