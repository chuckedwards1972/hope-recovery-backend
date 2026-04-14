import * as Sentry from '@sentry/node';
import { logger } from './logger';

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info('Sentry DSN not set — error tracking disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || '5.0.0',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Strip sensitive data from error reports
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
      return event;
    },
  });

  logger.info({ environment: process.env.NODE_ENV }, 'Sentry initialized');
}

// Capture non-fatal errors with context
export function captureError(err: Error, context?: Record<string, unknown>): void {
  Sentry.withScope((scope) => {
    if (context) {
      Object.entries(context).forEach(([key, value]) => {
        scope.setExtra(key, value);
      });
    }
    Sentry.captureException(err);
  });
}

// Set user context on authenticated requests
export function setSentryUser(userId: string, role: string, campusId: string): void {
  Sentry.setUser({ id: userId, role, campusId });
}

export { Sentry };
