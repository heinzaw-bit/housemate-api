import * as Sentry from '@sentry/node';

// Rebuild rather than blacklist: SDK upgrades must not add private payload fields.
export function sanitizeErrorEvent(
  event: Sentry.ErrorEvent,
): Sentry.ErrorEvent {
  const values = event.exception?.values?.map((exception) => ({
    type: [
      'Error',
      'TypeError',
      'RangeError',
      'ReferenceError',
      'SyntaxError',
    ].includes(exception.type ?? '')
      ? exception.type
      : 'Error',
    value: 'Unexpected HouseMate error (details withheld)',
    stacktrace: {
      frames:
        exception.stacktrace?.frames?.flatMap((frame) => {
          const file = frame.filename?.replaceAll('\\', '/').split(/[?#]/)[0];
          const match = file?.match(
            /(?:^|\/)((?:src|dist|_next\/static)\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?)$/,
          );
          if (!match) return [];
          return [
            {
              filename: match[1],
              lineno: frame.lineno,
              colno: frame.colno,
              function: /^[A-Za-z0-9_.$<> ]{1,100}$/.test(frame.function ?? '')
                ? frame.function
                : undefined,
            },
          ];
        }) ?? [],
    },
  }));
  const operation = [
    'api.request',
    'api.readiness',
    'api.notifications',
    'api.notifications.delivery',
    'api.database',
    'api.startup',
    'verification',
  ].includes(String(event.tags?.operation))
    ? String(event.tags?.operation)
    : 'api.request';
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: 'node',
    environment: 'production',
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    level: 'error',
    exception: {
      values: values?.length
        ? values
        : [
            {
              type: 'Error',
              value: 'Unexpected HouseMate error (details withheld)',
            },
          ],
    },
    tags: { operation },
    fingerprint: [
      operation,
      values?.[0]?.type ?? 'Error',
      values?.[0]?.stacktrace.frames?.at(-1)?.filename ?? 'unknown',
    ],
  };
}

export function initializeErrorReporting() {
  if (process.env.VERCEL_ENV !== 'production' || !process.env.SENTRY_DSN)
    return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: 'production',
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    tracesSampleRate: 0,
    beforeSendLog: () => null,
    tracePropagationTargets: [],
    sendClientReports: false,
    beforeSend: sanitizeErrorEvent,
    beforeBreadcrumb: () => null,
  });
}

export async function reportError(error: unknown, operation: string) {
  if (!Sentry.isEnabled()) return;
  try {
    Sentry.captureException(error, { tags: { operation } });
    // Serverless invocations may freeze after the reply. Reporting is bounded and never changes its result.
    await Sentry.flush(2000);
  } catch {
    /* Reporting must not make an outage worse. */
  }
}
