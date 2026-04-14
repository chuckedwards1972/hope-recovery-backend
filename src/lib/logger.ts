import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        // Production: JSON to stdout for log aggregation (Datadog, Logtail, etc.)
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

// Correlation ID middleware helper
export function withCorrelationId(correlationId: string) {
  return logger.child({ correlationId });
}

// Domain-specific child loggers
export const authLogger = logger.child({ module: 'auth' });
export const dbLogger = logger.child({ module: 'db' });
export const wsLogger = logger.child({ module: 'websocket' });
export const scoringLogger = logger.child({ module: 'scoring' });
export const cronLogger = logger.child({ module: 'cron' });
export const aiLogger = logger.child({ module: 'ai' });

export const lifecycleLogger = logger.child({ module: 'lifecycle' });
