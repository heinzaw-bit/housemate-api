import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import {
  configurationMatches,
  configureJob,
  createProviderClient,
  desiredJob,
  findJob,
  jobUrl,
} from './external-scheduler.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
export function uptimeJobs(apiOrigin, webOrigin) {
  const endpoints = [
    [
      'HouseMate API uptime',
      jobUrl(apiOrigin).replace('/internal/notifications/run', '/health/ready'),
    ],
    ['HouseMate web uptime', new URL(jobUrl(webOrigin)).origin + '/'],
  ];
  return endpoints.map(([title, url]) => ({
    ...desiredJob(url, 'Asia/Bangkok', ''),
    title,
    saveResponses: false,
    schedule: {
      ...desiredJob(url, 'Asia/Bangkok', '').schedule,
      minutes: Array.from({ length: 12 }, (_, i) => i * 5),
    },
    extendedData: { headers: {}, body: '' },
  }));
}

async function main() {
  const command = process.argv[2] ?? 'plan';
  if (!['plan', 'configure', 'status'].includes(command))
    throw new Error('Use plan, configure or status.');
  const local = parseEnv(
    readFileSync(resolve(directory, '.env.scheduler'), 'utf8'),
  );
  const jobs = uptimeJobs(
    process.env.REMINDER_API_ORIGIN || local.REMINDER_API_ORIGIN,
    process.env.UPTIME_WEB_ORIGIN ||
      local.UPTIME_WEB_ORIGIN ||
      'https://housemate-app-xi.vercel.app',
  );
  if (command === 'plan') {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }
  const request = createProviderClient(
    process.env.CRON_JOB_API_KEY || local.CRON_JOB_API_KEY,
  );
  const reports = [];
  for (const expected of jobs) {
    let jobId;
    if (command === 'configure') {
      const check = await fetch(expected.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (check.status !== 200)
        throw new Error(
          `Uptime target ${expected.title} returned HTTP ${check.status}. No job was enabled for it.`,
        );
      await check.body?.cancel();
      jobId = await configureJob(request, expected);
    } else jobId = await findJob(request, expected.url, expected.title);
    if (!jobId) throw new Error('Uptime checks have not been configured yet.');
    const actual = (await request(`/jobs/${jobId}`)).jobDetails;
    const last = Number(actual?.lastExecution) || 0;
    const healthy =
      actual?.enabled &&
      configurationMatches(actual, expected, true) &&
      actual.lastStatus === 1 &&
      Date.now() / 1000 - last < 900;
    reports.push({
      jobId,
      title: expected.title,
      url: expected.url,
      enabled: !!actual?.enabled,
      configurationValid: configurationMatches(actual, expected, true),
      lastHttpStatus: actual?.lastHttpStatus ?? null,
      lastRunAt: last ? new Date(last * 1000).toISOString() : null,
      healthy: !!healthy,
    });
  }
  if (command === 'configure') {
    mkdirSync(resolve(directory, '.run'), { recursive: true });
    writeFileSync(
      resolve(directory, '.run/uptime.json'),
      JSON.stringify(reports, null, 2),
    );
  }
  console.log(
    JSON.stringify(
      {
        intervalMinutes: 5,
        alerts: 'Account email: first failure, recovery, disablement',
        checks: reports,
      },
      null,
      2,
    ),
  );
  if (command === 'status' && reports.some((item) => !item.healthy))
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch(() => {
    console.error(
      'Uptime operation failed. Check target HTTP availability, scheduler access/quota and saved configuration. No private response was printed.',
    );
    process.exitCode = 1;
  });
