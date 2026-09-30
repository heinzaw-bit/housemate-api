# Manual Vercel deployment

Deploy `heinzaw-bit/housemate-api` and `heinzaw-bit/housemate-app` as separate Vercel projects, each from its repository root. The whole-project repository remains the shared documentation and submodule checkout. These instructions prepare an HTTPS API and web app; a real deployment and phone acceptance still require user actions.

## 1. Prepare private configuration

The current workspace has a prepared, ignored `.env.vercel` containing the verified transaction-pooler URI, existing Supabase URL/publishable key, and generated CRON_SECRET. Open it locally and copy the values privately into the API project's Vercel environment variables (without enclosing quotes if entering individual values). Replace its WEB_ORIGINS placeholder with the intended/actual web production origin. Keep this file private; it is deliberately absent from GitHub. Local `.env` remains intact.

For a fresh clone, from the API directory run `npm run cron:secret`. It adds a random 32-byte URL-safe secret to ignored `.env`, or retains an existing value. Copy CRON_SECRET privately to Vercel and your scheduler. Never commit it, send it in a URL/query, or add it to a NEXT_PUBLIC variable.

Open the existing Supabase project, choose **Connect → Transaction pooler**, and copy the PostgreSQL URI with the correct database password. Use the dashboard's actual pooler host and username; port 6543 is transaction mode. URL-encode special characters in the password. The existing project's migrations 001–015 are already applied. Do not rerun them as part of an import/build/request.

Vercel database connections verify the server certificate and hostname. The user supplied the public Supabase `prod-ca-2021.crt`, which is bundled in `src/supabase-ca.ts` together with standard trusted roots. Certificate-validated read-only connectivity to `aws-0-ap-south-1.pooler.supabase.com:6543` and the existing reminder function were verified using the prepared private settings. No extra CA environment variable is needed for this pooler. For a future/custom host, `DATABASE_SSL_CA` may override the trust bundle with its trusted PEM. Do not disable TLS verification to bypass a certificate error. Use the transaction pooler with the existing unnamed node-postgres queries; no named prepared statements are configured.

## 2. Import the API

1. Sign in to Vercel and connect GitHub as **heinzaw-bit**, granting access to the API and app repositories.
2. Choose **Add New → Project → housemate-api → Import**.
3. Name the project `housemate-api`; keep Root Directory at the repository root and production branch `main`.
4. Framework: **Fastify**. Node.js: **24.x**. Keep framework build/output defaults; do not configure a static `dist` output directory or a persistent `npm start` process. `vercel.json` selects Fastify and Fluid compute. In project Settings → Functions, set the default maximum duration to **120 seconds** and region to **Mumbai (`bom1`)**. `src/app.ts` directly imports Fastify and passes its factory into the shared runtime, which preserves the same routes and logging settings as local startup. Vercel's builder requires this direct framework import in the detected entry point. Do not add a `functions["src/app.ts"]` override: the builder rejects that pattern before detecting the server. The timeout is a project setting (`resourceConfig.functionDefaultTimeout` in the management API).
5. Add the following production environment variables before deployment:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Transaction-pooler URI from the existing Supabase project |
| `SUPABASE_URL` | Existing project's HTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | Existing publishable key |
| `WEB_ORIGINS` | Exact intended web production origin, such as `https://your-selected-name.vercel.app`; update to the actual assigned domain after web deployment |
| `CRON_SECRET` | Private generated job secret |
| `DATABASE_SSL_CA` | Optional trusted database CA PEM, only if required |

Vercel supplies `VERCEL=1`; do not set it locally. On Vercel the API refuses startup without CRON_SECRET and explicit WEB_ORIGINS. Keep API and web configuration scoped to their respective projects. Browser variables never include database/job/VAPID private credentials. Leave VAPID configuration unset while no real public contact is available.

6. Click **Deploy** and copy the stable production API domain from Vercel. Do not assume the chosen project name guarantees a particular domain. The entry point starts `listen()` without top-level `await`, so Vercel can finish loading the module before its intercepted listener resolves.
7. Open `https://ACTUAL-API-DOMAIN/health`. Expect `{"status":"ok"}`. This checks startup only, not database/auth access. Opening `/internal/notifications/run` without its private header must return 401.

## 3. Import the web app and finish origin configuration

1. Import `heinzaw-bit/housemate-app` with project name `housemate-app`, root at repository root, Next.js preset, Node.js 24.x, and normal build/output defaults.
2. Add `NEXT_PUBLIC_API_URL` with the actual API HTTPS origin (no `/v1` path), plus `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the same Supabase project. Set `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true` only when Google Auth is configured, otherwise false.
3. Deploy and copy the actual stable web production origin.
4. In API Settings → Environment Variables, replace WEB_ORIGINS with that exact web origin, without a trailing slash/path. Redeploy the API. A comma-separated list may include `http://localhost:3000` if local development also needs this API. Preview domains require explicit CORS and Auth allowlisting; they are not automatically accepted.
5. In Supabase Authentication → URL Configuration, set Site URL to the web production origin and add that exact origin to Redirect URLs. Keep the existing localhost redirect for development. This app redirects sign-in to the origin, not a separate `/auth/callback` page.
6. Sign in and read existing household data through the web app. Verify API CORS, Auth, and database connectivity before creating test records. No separate Supabase project or migration reset is needed.

## 4. Schedule notifications on Hobby

The user chose Vercel Hobby plus an external scheduler. The repository intentionally has no `crons` entry; Hobby's built-in daily scheduling cannot preserve these minute-level reminder windows.

For example, [cron-job.org](https://cron-job.org/en/) supports minute schedules and custom request headers:

1. Create/sign in to your scheduler account manually.
2. Create a job named **HouseMate notifications**.
3. URL: `https://ACTUAL-API-DOMAIN/internal/notifications/run` using the stable production API domain.
4. Method: **GET**. Schedule: **every minute**.
5. Add custom header **Authorization** with value **Bearer YOUR_PRIVATE_CRON_SECRET**. Use the same value as the API's environment variable, with a space after Bearer. Do not put the secret into the job URL.
6. Enable failure notifications in the scheduler and run its test request. Expect HTTP 200 with `{"status":"ok"}`; no private household content is returned.
7. Verify several successful scheduled runs. A 401 means missing/mismatched job credentials. A 503 means a running/failed batch; inspect API logs and allow a later retry. A 404 means the wrong URL or old deployment.

Production API access must reach the app's own authorization checks. If Vercel Deployment Protection intercepts requests with its login page, configure the production API to be reachable by your web client and scheduler. Do not substitute a member access token for the job secret. Rotating CRON_SECRET requires updating both Vercel (and redeploying) and the scheduler.

cron-job.org waits up to 30 seconds. The Vercel ceiling is a recovery limit, not a promise of a 30-second batch. Current live push is disabled, so jobs generate in-app reminders only. Once push is configured or the household workload grows, monitor job duration and queue backlog; choose a scheduler with a longer timeout if needed. Existing queue leases and deterministic keys permit retries, but provider acceptance/device delivery are not exactly once.

## 5. Acceptance

- Health responds; unauthenticated household routes and job requests return 401.
- Sign-in returns to the production web origin and existing household records load.
- Scheduler test and repeated minute runs return 200; deadline reminders appear for authorized recipients.
- The API's database pool uses verified TLS with one connection per warm instance; no migration runs during requests.
- Follow the web app's `QUALITY_CHECKS.md` on Android Chrome and iPhone Safari for production installation, standalone launch, icons/safe areas, offline navigation, reconnection, interrupted confirmation, and updates with drafts open.

No live Vercel deployment, scheduler account/job, or actual-device verification is performed by adding these files. Live web push remains disabled pending the user's real public contact.

## References

- [Vercel Fastify entry points](https://vercel.com/docs/frameworks/backend/fastify)
- [Vercel cron authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Vercel cron plan limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Supabase serverless connections](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase sign-in redirects](https://supabase.com/docs/guides/auth/redirect-urls)
- [cron-job.org execution limits](https://cron-job.org/en/faq/)
