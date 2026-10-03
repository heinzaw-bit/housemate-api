import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configureJob, desiredJob, findJob } from './external-scheduler.mjs';

const root = resolve(import.meta.dirname, '../.run');
const statePath = resolve(root, 'monitor-alert-drill.json');
const title = 'HouseMate isolated monitor alert test';
const save = (state) =>
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });

export async function manageAlertDrill(command, request, readinessUrl) {
  mkdirSync(root, { recursive: true });
  let state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : null;
  if (command === 'alert-start') {
    if (state?.completedAt)
      throw new Error(
        'Previous alert test completed; preserve its evidence before beginning a new test',
      );
    if (!state) {
      const origin = new URL(readinessUrl).origin;
      state = {
        title,
        failureUrl: `${origin}/health/alert-check-${randomUUID()}`,
        recoveryUrl: `${origin}/health`,
        phase: 'failure',
        startedAt: new Date().toISOString(),
      };
      save(state);
    }
    if (state.phase !== 'failure')
      throw new Error('An alert test already progressed to recovery');
    const check = await fetch(state.failureUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    await check.body?.cancel();
    if (check.status !== 404)
      throw new Error(
        'Isolated failure URL did not return the expected HTTP 404',
      );
    const expected = {
      ...desiredJob(state.failureUrl, 'Asia/Bangkok', ''),
      title,
      saveResponses: false,
      extendedData: { headers: {}, body: '' },
    };
    // The provider expects a local YYYYMMDDhhmmss number, not a Unix timestamp.
    expected.schedule.expiresAt = Number(
      new Date(Date.now() + 8 * 3600000)
        .toISOString()
        .slice(0, 19)
        .replaceAll(/[-T:]/g, ''),
    );
    state.jobId = await configureJob(request, expected);
    save(state);
    return {
      jobId: state.jobId,
      phase: state.phase,
      isolatedTest: true,
      alerts: 'Owner email: failure and recovery',
      expiresWithinMinutes: 60,
      nextStep:
        'After a scheduled failure, run uptime:alert-recover. Confirm actual emails separately.',
    };
  }
  if (!state?.jobId || state.title !== title)
    throw new Error('No owned alert test exists');
  if ([8546464, 8546966, 8546967].includes(state.jobId))
    throw new Error('Protected production monitor ID');
  const actual = (await request(`/jobs/${state.jobId}`)).jobDetails;
  if (
    actual.title !== title ||
    ![state.failureUrl, state.recoveryUrl].includes(actual.url) ||
    Object.keys(actual.extendedData?.headers ?? {}).length !== 0
  )
    throw new Error('Alert test ownership/settings did not match');
  const history = (await request(`/jobs/${state.jobId}/history`)).history;
  if (!Array.isArray(history))
    throw new Error('Alert test history unavailable');
  state.failureObserved ||= history.some(
    (r) => r.url === state.failureUrl && r.status === 4 && r.httpStatus === 404,
  );
  state.recoveryObserved ||=
    state.failureObserved &&
    history.some(
      (r) =>
        r.url === state.recoveryUrl && r.status === 1 && r.httpStatus === 200,
    );
  save(state);
  if (command === 'alert-recover') {
    if (!state.failureObserved)
      throw new Error('A scheduled failure has not been verified yet');
    state.phase = 'recovery';
    save(state);
    await request(`/jobs/${state.jobId}`, 'PATCH', {
      job: { url: state.recoveryUrl, enabled: true },
    });
  } else if (command === 'alert-cleanup') {
    if (!state.recoveryObserved)
      throw new Error('A scheduled recovery has not been verified yet');
    await request(`/jobs/${state.jobId}`, 'DELETE');
    state.completedAt = new Date().toISOString();
    save(state);
  } else if (command !== 'alert-status')
    throw new Error('Unknown alert test command');
  return {
    jobId: state.jobId,
    enabled: !!actual.enabled,
    lastStatus: actual.lastStatus,
    nextExecution: actual.nextExecution
      ? new Date(actual.nextExecution * 1000).toISOString()
      : null,
    expiresAt: actual.schedule?.expiresAt,
    phase: state.phase,
    failureObserved: !!state.failureObserved,
    recoveryObserved: !!state.recoveryObserved,
    removed: !!state.completedAt,
    emailReceiptVerified: false,
    recentRuns: history.slice(0, 5).map((r) => ({
      runAt: new Date(r.date * 1000).toISOString(),
      status: r.status,
      httpStatus: r.httpStatus,
      durationMs: r.duration,
    })),
  };
}
