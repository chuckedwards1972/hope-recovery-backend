import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { v4 as uuid } from 'uuid';

import { prisma } from './lib/prisma';
import { logger } from './lib/logger';
import { initSentry, Sentry } from './lib/sentry';
import { errorHandler } from './middleware/errorHandler';
import { initWebSocket } from './lib/websocket';
import { startScoringCron, startSustainabilityCron, startDigestCron, startLifecycleCron } from './jobs/scoringCron';

// Routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import campusRoutes from './routes/campuses';
import meetingRoutes from './routes/meetings';
import attendanceRoutes from './routes/attendance';
import donationRoutes from './routes/donations';
import workforceRoutes from './routes/workforce';
import housingRoutes from './routes/housing';
import testimonyRoutes from './routes/testimonies';
import analyticsRoutes from './routes/analytics';
import eventsRoutes from './routes/events';
import workflowRoutes from './routes/workflows';
import meetingPrepRoutes from './routes/meetingPrep';
import mediaRoutes from './routes/media';
import scoringRoutes from './routes/scoring';
import announcementRoutes from './routes/announcements';
import aiRoutes from './routes/ai';
import expansionRoutes from './routes/expansion';

// ─── Initialize Sentry before anything else ──
initSentry();

const app = express();
const httpServer = createServer(app);

// ─── Sentry request handler (must be first) ──
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

// ─── Security ────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: process.env.NODE_ENV === 'production',
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

// ─── Correlation ID ───────────────────────────
app.use((req, _res, next) => {
  (req as any).correlationId = req.headers['x-correlation-id'] || uuid();
  next();
});

// ─── Structured request logging (Pino) ───────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      correlationId: (req as any).correlationId,
    });
  });
  next();
});

// ─── Rate limiting ────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

const workflowLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many workflow requests. Please slow down.' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many upload requests.' },
});

// ─── Body parsing ─────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health check ─────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION || '5.0.0',
      env: process.env.NODE_ENV,
    });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

// ─── API Routes ───────────────────────────────
app.use('/api/auth',         authLimiter,     authRoutes);
app.use('/api/users',                         userRoutes);
app.use('/api/campuses',                      campusRoutes);
app.use('/api/meetings',                      meetingRoutes);
app.use('/api/attendance',                    attendanceRoutes);
app.use('/api/donations',                     donationRoutes);
app.use('/api/workforce',                     workforceRoutes);
app.use('/api/housing',                       housingRoutes);
app.use('/api/testimonies',                   testimonyRoutes);
app.use('/api/analytics',                     analyticsRoutes);
app.use('/api/events',                        eventsRoutes);
app.use('/api/workflows',   workflowLimiter,  workflowRoutes);
app.use('/api/meeting-prep',                  meetingPrepRoutes);
app.use('/api/media',       uploadLimiter,    mediaRoutes);
app.use('/api/scoring',                       scoringRoutes);
app.use('/api/announcements',                 announcementRoutes);
app.use('/api/ai',                            aiRoutes);
app.use('/api/expansion',                     expansionRoutes);

// ─── Sentry error handler (before errorHandler) ─
app.use(Sentry.Handlers.errorHandler());

// ─── Global error handler ─────────────────────
app.use(errorHandler);

// ─── WebSocket ────────────────────────────────
initWebSocket(httpServer);

// ─── Start ────────────────────────────────────
const PORT = parseInt(process.env.PORT || '4000');

async function main() {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    httpServer.listen(PORT, () => {
      logger.info({ port: PORT, env: process.env.NODE_ENV }, 'POLR API v5 started');
    });

    // Start background jobs
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_CRONS === 'true') {
      startScoringCron();
      startSustainabilityCron();
      startDigestCron();
      startLifecycleCron();
      logger.info('Background cron jobs started');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main();

// ─── Graceful shutdown ────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await prisma.$disconnect();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
