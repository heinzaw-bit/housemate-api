import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const apiDirectory = fileURLToPath(new URL('../', import.meta.url));
const provider = 'https://api.cron-job.org';
const title = 'HouseMate notifications';
const statusNames = [
  'Not run yet',
  'OK',
  'DNS error',
  'Connection failed',
  'HTTP error',
  'Timeout',
  'Response too large',
  'Invalid URL',
  'Provider error',
  'Unknown failure',
];
const scheduleFields = ['hours', 'mdays', 'minutes', 'months', 'wdays'];

function readEnv(path, optional = false) {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch {
    if (optional) return {};
    throw new Error('Cannot read the private scheduler configuration file.');
  }
}

export function jobUrl(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(
      'Set REMINDER_API_ORIGIN to the production API HTTPS origin.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'REMINDER_API_ORIGIN must be an HTTPS origin without credentials, a port, or a path.',
    );
  }
  return `${url.origin}/internal/notifications/run`;
}

export function desiredJob(url, timezone, secret) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('Invalid REMINDER_TIMEZONE.');
  }
  return {
    title,
    url,
    enabled: false,
    requestMethod: 0,
    requestTimeout: 30,
    saveResponses: true,
    redirectSuccess: false,
    auth: { enable: false },
    schedule: {
      timezone,
      expiresAt: 0,
      ...Object.fromEntries(scheduleFields.map((key) => [key, [-1]])),
    },
    notification: {
      onFailure: true,
      onFailureCount: 1,
      onSuccess: true,
      onDisable: true,
      onSslCertExpiry: true,
      onSslCertExpirySeconds: 604800,
      mode: 2,
      selectedChannels: [0],
    },
    extendedData: { headers: { Authorization: `Bearer ${secret}` }, body: '' },
  };
}

export function configurationMatches(actual, expected, compareSecret = false) {
  if (
    !actual ||
    actual.url !== expected.url ||
    actual.requestMethod !== 0 ||
    actual.requestTimeout !== 30 ||
    actual.redirectSuccess !== false ||
    actual.auth?.enable === true
  )
    return false;
  if (
    actual.schedule?.timezone !== expected.schedule.timezone ||
    actual.schedule.expiresAt !== 0
  )
    return false;
  if (
    !scheduleFields.every(
      (key) =>
        JSON.stringify(actual.schedule[key]) ===
        JSON.stringify(expected.schedule[key]),
    )
  )
    return false;
  const notice = actual.notification;
  if (
    !notice?.onFailure ||
    notice.onFailureCount !== 1 ||
    !notice.onSuccess ||
    !notice.onDisable ||
    notice.mode !== 2 ||
    JSON.stringify(notice.selectedChannels) !== '[0]'
  )
    return false;
  const authorization = actual.extendedData?.headers?.Authorization;
  if (!expected.extendedData.headers.Authorization)
    return (
      !authorization &&
      Object.keys(actual.extendedData?.headers ?? {}).length === 0
    );
  return compareSecret
    ? authorization === expected.extendedData.headers.Authorization
    : typeof authorization === 'string' && authorization.startsWith('Bearer ');
}

export function createProviderClient(apiKey, fetcher = fetch) {
  if (!apiKey || /\s/.test(apiKey))
    throw new Error(
      'Add CRON_JOB_API_KEY to ignored .env.scheduler; do not paste it into chat.',
    );
  return async (path, method = 'GET', body) => {
    let response;
    try {
      response = await fetcher(`${provider}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        'Scheduler request did not complete. For setup, rerun configure to discover any already-created job before retrying.',
      );
    }
    if (!response.ok)
      throw new Error(
        `Scheduler API returned HTTP ${response.status}. Check account access or quota.`,
      );
    try {
      return await response.json();
    } catch {
      throw new Error('Scheduler API returned an unreadable response.');
    }
  };
}

export async function findJob(request, url, expectedTitle = title) {
  const inventory = await request('/jobs');
  if (inventory.someFailed !== false || !Array.isArray(inventory.jobs))
    throw new Error(
      'Scheduler job inventory is incomplete; setup stopped to avoid duplicate jobs.',
    );
  const matches = inventory.jobs.filter((job) => job.url === url);
  if (matches.length > 1)
    throw new Error(
      'More than one reminder job exists for this URL. Resolve duplicate jobs in the scheduler console.',
    );
  if (
    !matches.length &&
    inventory.jobs.some((job) => job.title === expectedTitle)
  )
    throw new Error(
      'A HouseMate job exists with a different URL. Review it in the scheduler console first.',
    );
  if (
    matches.length &&
    (!Number.isSafeInteger(matches[0].jobId) || matches[0].jobId <= 0)
  )
    throw new Error('Scheduler returned an invalid job identifier.');
  return matches[0]?.jobId ?? null;
}

export async function configureJob(request, expected) {
  let jobId = await findJob(request, expected.url, expected.title);
  if (jobId) {
    await request(`/jobs/${jobId}`, 'PATCH', { job: expected });
  } else {
    const created = await request('/jobs', 'PUT', { job: expected });
    jobId = created.jobId;
    if (!Number.isSafeInteger(jobId) || jobId <= 0)
      throw new Error(
        'Scheduler did not return a valid job identifier. Rerun configure to rediscover the job.',
      );
  }
  const configured = (await request(`/jobs/${jobId}`)).jobDetails;
  if (!configurationMatches(configured, expected, true))
    throw new Error(
      'Saved scheduler settings did not match. The job remains disabled; inspect the console before enabling it.',
    );
  await request(`/jobs/${jobId}`, 'PATCH', { job: { enabled: true } });
  const enabled = (await request(`/jobs/${jobId}`)).jobDetails;
  if (!enabled?.enabled || !configurationMatches(enabled, expected, true))
    throw new Error(
      'Could not verify the enabled scheduler settings. Inspect the scheduler console.',
    );
  return jobId;
}

export function summarize(job, expected, now = Date.now()) {
  const lastExecution = Number(job.lastExecution) || 0;
  const status = Number(job.lastStatus) || 0;
  const configurationValid = configurationMatches(job, expected);
  const stale = !lastExecution || now / 1000 - lastExecution > 180;
  return {
    jobId: job.jobId,
    url: expected.url,
    enabled: !!job.enabled,
    configurationValid,
    schedule: 'Every minute',
    timezone: expected.schedule.timezone,
    alerts: 'Account email: failure, recovery and automatic disablement',
    lastStatus: statusNames[status] ?? 'Unknown failure',
    lastHttpStatus: job.lastHttpStatus ?? null,
    lastRunAt: lastExecution
      ? new Date(lastExecution * 1000).toISOString()
      : null,
    lastDurationMs: job.lastDuration ?? null,
    stale,
    healthy: !!job.enabled && configurationValid && !stale && status === 1,
  };
}

async function main() {
  const command = process.argv[2] ?? 'plan';
  if (!['plan', 'configure', 'status'].includes(command))
    throw new Error(
      'Use plan, configure, or status (optionally status --history).',
    );
  const local = readEnv(resolve(apiDirectory, '.env.scheduler'), true);
  const origin = process.env.REMINDER_API_ORIGIN || local.REMINDER_API_ORIGIN;
  const timezone =
    process.env.REMINDER_TIMEZONE || local.REMINDER_TIMEZONE || 'Asia/Bangkok';
  const url = jobUrl(origin);
  const expected = desiredJob(url, timezone, 'REDACTED');
  if (command === 'plan') {
    console.log(
      JSON.stringify(
        {
          provider,
          ...expected,
          extendedData: {
            headers: { Authorization: 'Bearer [private CRON_SECRET]' },
          },
          activation: 'Verify settings, then enable',
        },
        null,
        2,
      ),
    );
    return;
  }
  const request = createProviderClient(
    process.env.CRON_JOB_API_KEY || local.CRON_JOB_API_KEY,
  );
  let jobId;
  if (command === 'configure') {
    const production = readEnv(resolve(apiDirectory, '.env.vercel'), true);
    const secret = process.env.CRON_SECRET || production.CRON_SECRET;
    if (!secret || !/^[A-Za-z0-9_-]{32,}$/.test(secret))
      throw new Error(
        'Set the production CRON_SECRET in ignored .env.vercel or the process environment.',
      );
    let test;
    try {
      test = await fetch(url, {
        headers: { Authorization: `Bearer ${secret}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error(
        'The production reminder endpoint could not be reached. Scheduler settings were not changed.',
      );
    }
    if (test.status !== 200 || (await test.json()).status !== 'ok')
      throw new Error(
        'The production reminder test failed. Scheduler settings were not changed.',
      );
    jobId = await configureJob(request, desiredJob(url, timezone, secret));
    mkdirSync(resolve(apiDirectory, '.run'), { recursive: true });
    writeFileSync(
      resolve(apiDirectory, '.run/external-scheduler.json'),
      JSON.stringify(
        { provider, jobId, url, configuredAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        {
          jobId,
          url,
          enabled: true,
          schedule: 'Every minute',
          timezone,
          alerts: 'Account email: failure, recovery and automatic disablement',
          scheduledRunsVerified: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  jobId = await findJob(request, url);
  if (!jobId)
    throw new Error(
      'No reminder scheduler job exists yet. Run scheduler:configure after connecting the account.',
    );
  const job = (await request(`/jobs/${jobId}`)).jobDetails;
  if (!job || job.jobId !== jobId)
    throw new Error('Scheduler returned unexpected job details.');
  const report = summarize(job, expected);
  if (process.argv.includes('--history')) {
    const history = (await request(`/jobs/${jobId}/history`)).history;
    if (!Array.isArray(history))
      throw new Error('Scheduler history was unreadable.');
    report.recentRuns = history.slice(0, 10).map((item) => ({
      runAt: new Date(item.date * 1000).toISOString(),
      status: statusNames[item.status] ?? 'Unknown failure',
      httpStatus: item.httpStatus,
      durationMs: item.duration,
    }));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.healthy) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
