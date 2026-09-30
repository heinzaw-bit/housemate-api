# HouseMate API

Independent Node.js/TypeScript API for the HouseMate web and future mobile clients, published as [heinzaw-bit/housemate-api](https://github.com/heinzaw-bit/housemate-api). This repository owns its dependencies, migrations, tests, CI, and [OpenAPI contract](openapi.yaml). The [whole-project repository](https://github.com/heinzaw-bit/housemate) includes it as the `api/` submodule alongside the independent web app.

Shared product scope and engineering context live in the umbrella's [SPEC](https://github.com/heinzaw-bit/housemate/blob/main/SPEC.md) and [handoff](https://github.com/heinzaw-bit/housemate/blob/main/PROJECT_HANDOFF.md). Local `AGENTS.md` preserves the shared engineering boundaries; `api/openapi.yaml` in those workspace rules means `openapi.yaml` when this repository is cloned alone. Run the commands below from this repository root. No sibling checkout is required.

## Implemented slice

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

Balances combine confirmed expenses, **Paid** bills, and recorded manual transfers. An Unpaid bill stays pending and does not affect member balances until marked Paid. Positive net amounts are owed to a member; negative amounts are what the member owes. The per-member entries endpoint lists the source amounts and their signed balance effects. Settlement suggestions are informational. Either the sender or recipient may preview and record a transfer that happened outside HouseMate; the API warns when a custom amount exceeds the suggested amount. Confirmation uses an idempotency key and stores who recorded the transfer and when. HouseMate does not process or verify payments.

The record creator or a household owner/admin can edit an expense or bill. The edit preview recalculates shares and returns a ten-minute preview ID tied to the exact draft and record revision. Confirmation requires that preview ID, the expected revision, and an idempotency key. A changed record or expired preview returns a conflict that calls for a fresh preview. Each edit stores before/after snapshots in `financial_edit_events`. Bill payment status remains on the separate status endpoint and advances the bill revision when changed.

The same creator or owner/admin permission applies to voids. The API previews exact member balance changes for an expense or Paid bill, or the pending-total change for an Unpaid bill. Confirmation uses a ten-minute preview ID, record revision, and idempotency key. A voided record stays in lists with actor, time, and optional reason, but can no longer be edited or have its payment status changed. Voided shares are excluded from active balances; previously recorded settlements remain. The before/after void snapshots are stored in `financial_edit_events` with action `void`.

Any active member can read a record's paginated history. The API combines its original creation, edit and void snapshots, and bill provider-status events into entries with actor, time, and human-readable changed fields with old and new values. History checks active household membership and scopes the record ID to that household. Recorded manual transfers remain available through the settlement history endpoint.

Any active member can create a meal check and assign cooking roles to selected active participants. The API interprets meal time and response deadline in the household timezone and rejects invalid or past deadlines. Only selected active members can answer, and their answers lock at the deadline. Creation is idempotent. Meal records stay in the private schema and every read or write checks active household membership.

Any active member can create a future event with optional details, location, and end time. The API interprets times in the household timezone. Active members can read upcoming and past events and change only their own Going, Maybe, or Not going attendance until the event starts. Creation is idempotent, and every event operation checks active household membership. The event detail supplies current Going members for an optional expense draft suggestion; the normal expense preview and confirmation remain authoritative.

Any active member can publish announcements and polls to selected active members. Recipients/voters, the author, and active owners/admins may read them. Published content and audience stay fixed. Announcements support optional acknowledgement and expiry; only selected active recipients can acknowledge as themselves, and retries retain the original timestamp. Polls require 2–10 distinct options and a future deadline. Only selected active voters can replace or withdraw their own selections before that deadline. Aggregate results include previous votes from departed members. Transactions and database constraints prevent duplicate votes, multiple selections in a single-choice poll, and foreign-poll options. Publication uses scoped idempotency keys.

Any active member can create a one-off chore due in the household timezone for an active member. The assignee or an owner/admin can complete it or skip with a required reason. An assignee can ask another active member to take the chore; that member accepts or declines. Owners/admins can directly reassign, which cancels a pending swap. The API checks active membership, household scope, permission, and the chore revision for every change. The dashboard includes live open and overdue chore counts and the next due chore. Recurrence remains an open product decision.

Any active member can add, edit, assign, cancel, or purchase an open shopping item. Items have optional quantity, note, and prices in integer minor units with an explicit currency. The first saved shopping price locks household currency. Purchased and cancelled items remain visible but cannot be changed again. The `/purchase-with-expense` route uses the normal expense calculation, confirms the expense and purchase in one database transaction, and links the item to the expense. It accepts the same UUID retry key as an expense confirmation; a repeat with identical details returns the original result. Marking purchased without an expense does not change balances. Every shopping operation checks active household membership; changes to an existing item require its current revision.

## Local setup

1. Create a Supabase project and obtain its URL, publishable key, and a PostgreSQL connection URL for a trusted server. Do not place the database URL in a web or mobile client.
2. Copy `.env.example` to `.env` and fill in the values. Set `WEB_ORIGINS` to the exact browser app origin or a comma-separated list of allowed origins. Mobile requests do not need CORS.
3. Apply `sql/001_household_foundation.sql`, then `sql/002_member_onboarding.sql` to the Supabase database with a privileged migration connection. Run `npm run migrate:expenses`, `npm run migrate:bills`, `npm run migrate:settlements`, `npm run migrate:edits`, `npm run migrate:voids`, `npm run migrate:meals`, `npm run migrate:shopping`, `npm run migrate:shopping-currency`, `npm run migrate:chores`, `npm run migrate:events`, `npm run migrate:announcements-polls`, and `npm run migrate:notifications` in that order to apply SQL files 003–015. The notification runner applies 014 once and reapplies the safe function correction in 015. The schema is private and is not exposed through Supabase's Data API. All fifteen migrations are applied in the configured project.
4. Run `npm ci` and `npm run dev` in this directory. The development command builds once and starts the API; restart it after changing API code or adding endpoints. If the web app says a feature needs a newer HouseMate API, restart this command and refresh the page.

`npm run lint`, `npm run build`, `npm run typecheck`, and `npm test` check the code. `npm run smoke:expenses`, `npm run smoke:bills`, `npm run smoke:settlements`, `npm run smoke:edits`, and `npm run smoke:voids` exercise the configured database inside transactions that are rolled back. The edit and void checks cover history values, unauthorized actions, foreign-household IDs, previews, idempotency, audit snapshots, and balances. The same standard checks run in `.github/workflows/ci.yml` when this directory becomes its own repository. `npm start` runs compiled output with environment variables supplied by the host.

`npm run smoke:meals` checks meal creation, safe retry, responses, cooking roles, the dashboard's next meal, deadline enforcement, and household isolation. Its fixture is rolled back.

`npm run smoke:events` checks event creation, retry safety, attendance changes, the start-time lock, and household isolation. Its fixture is rolled back.

`npm run smoke:announcements-polls` checks publication retries, targeted privacy, acknowledgement timestamps and expiry, vote replacement and withdrawal, single/multiple choices, database constraints, departed members, deadlines, personal House actions, and RLS. It uses an isolated household fixture and rolls it back.

`npm run smoke:shopping` checks item creation, editing, assignment, cancellation, purchases with and without expenses, atomic linking, retry safety, balances, the dashboard count, and household isolation. Its fixtures are rolled back.

`npm run smoke:house-actions` checks the personal House action preview for meal replies, swap requests, assigned chores, and assigned shopping; it also checks that closed items disappear and that foreign users cannot read the summary. Its fixtures are rolled back.

## Contract and deployment

`openapi.yaml` describes the implemented endpoints. Clients should pin a compatible contract version. Production deployments must set `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`, terminate TLS at the edge, and allow the API to reach Supabase Auth and PostgreSQL. Never expose the database connection URL or an administrative key to a client.

See [manual Vercel deployment](DEPLOYMENT.md) for the prepared Fastify entry point, verified database TLS, required `CRON_SECRET`, and Hobby-compatible external notification scheduling. `src/application.ts` is the injectable route factory; `src/runtime.ts` wires production dependencies; `src/app.ts` is Vercel's detected server entry point; `src/main.ts` retains local/persistent-host startup. Vercel does not run a background interval. Its warm instances share a module-level pool capped at one connection, with a five-second connection timeout and verified TLS. The user's public Supabase CA is bundled in `src/supabase-ca.ts` alongside the standard trusted roots, so the current pooler needs no extra CA environment variable. Optional `DATABASE_SSL_CA` overrides the trust bundle for a future/custom host. URL SSL flags cannot disable verification. Neither entry point runs database migrations.

Expense, bill, and shopping lists return up to 100 records per request with `limit` and `offset`; source entries and settlement history are paginated too. Meal, event, announcement, and poll lists return up to 50 records per page with `limit` and `offset`. Meals support `scope=reply|upcoming|past`; events support `scope=upcoming|past`; announcements support `scope=all|needs_ack|expired`; polls support `scope=open|needs_vote|closed`. Details are in the root `SPEC.md` and domain documents.

## Notifications and optional web push

Migration 014 adds four private RLS-enabled tables: recipient notifications, member preferences, account browser subscriptions, and push deliveries. Invoker trigger functions create feed entries in the same transaction as the originating household action. Migration 015 fixes a trigger variable/column naming conflict found during database verification. Never run migrations during requests.

On local/persistent hosts, the API runs the notification worker at startup and every 60 seconds, including when push is unconfigured. On Vercel, schedule `GET /internal/notifications/run` every minute through an external scheduler with `Authorization: Bearer <CRON_SECRET>`; the user selected Hobby plus external scheduling. No Vercel cron is configured, so Hobby imports do not fail its once-daily cron limit. Missing/invalid job credentials fail closed, member JWTs do not authorize jobs, and responses never contain household data. Overlapping calls on the same instance return 503 with Retry-After 60; failed batches return a sanitized 503 for scheduler monitoring/retry. Deterministic event keys deduplicate reminder phases. Delivery uses atomic `SKIP LOCKED` claims, expiring leases, bounded retries, and sanitized error codes. Multiple instances can share the queue. Provider 404/410 disables a subscription. Quiet hours delay every priority; current access, preferences, read state, expiry, and response/completion state are rechecked before sending. There is no guarantee that a provider-accepted push reaches a device, and retries can repeat a provider-accepted message; topics and service-worker tags coalesce duplicates.

To enable optional web push:

1. Run `npm run push:keys` once. It adds a VAPID keypair to ignored `.env` without printing private values or replacing an existing pair.
2. Set `VAPID_SUBJECT` to a real public `mailto:` contact or HTTPS support URL that you control, and keep `VAPID_PRIVATE_KEY` on the API only. The API exposes only the public key to authenticated clients. Do not invent a contact or use localhost as the contact URL.
3. Restart the API, then use Notifications → Settings → Enable push in this browser. Production web requires HTTPS. Some mobile browsers require installing the PWA. Allow API outbound access to the supported browser push providers (Google, Mozilla, Apple, Windows).

Without a complete VAPID/contact configuration, `/v1/push-config` reports disabled and device registration returns 503. The current local setup has keys but no user-provided public contact, so live push is disabled. Inbox, preferences, and reminder generation remain active. Lock-screen text is generic and contains no amounts, household names, or private messages. Devices belong to one account across households; new opt-in does not replay old notifications. Existing subscriptions refresh on a signed-in visit, but a missing or disabled subscription requires explicit Enable again. Native mobile push, email, SMS, and LINE providers are not implemented.

`npm run smoke:notifications` uses an isolated transaction and simulated push transport to check recipient privacy, retry deduplication, read ownership, cursor precision, preferences, deadline reminders, device ownership, quiet deferral, disabling, invalid-subscription handling, and RLS, then rolls back. It never contacts a browser push service. Actual device delivery still needs checking once a contact is configured.

## Dashboard verification

Run `npm run smoke:dashboard` with the configured `DATABASE_URL`. It uses two existing signed-in users, creates isolated fixtures inside a transaction, and always rolls them back. It checks USD/THB totals, household timezone due boundaries, Paid/void exclusions, edits and reported transfers, more than 50 pending bills, stable activity ordering, and access isolation. No real household financial record is changed.
