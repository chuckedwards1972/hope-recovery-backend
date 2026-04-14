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
import notificationRoutes from './routes/notifications';
import taskRoutes from './routes/tasks';
import grantRoutes from './routes/grants';
import pipelineRoutes from './routes/pipeline';
import missionRoutes from './routes/missions';

// â”€â”€â”€ Initialize Sentry before anything else â”€â”€
initSentry();

const app = express(); app.set("trust proxy", 1);
const httpServer = createServer(app);

// â”€â”€â”€ Sentry request handler (must be first) â”€â”€
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

// â”€â”€â”€ Security â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: process.env.NODE_ENV === 'production',
}));

app.use(cors({
  origin: ['https://hope-recovery-network.vercel.app', 'http://localhost:5173', process.env.CORS_ORIGIN].filter(Boolean),
  credentials: true,
}));

// â”€â”€â”€ Correlation ID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((req, _res, next) => {
  (req as any).correlationId = req.headers['x-correlation-id'] || uuid();
  next();
});

// â”€â”€â”€ Structured request logging (Pino) â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Rate limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Body parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// â”€â”€â”€ Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ API Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
app.use('/api/expansion', expansionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/grants', grantRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/missions', missionRoutes);
app.get('/api/dashboard', (req, res) => res.json({ members:{active:0,total:0}, housing:{total_capacity:0,occupied:0}, financial:{month_donations:0} }));

// â”€â”€â”€ Sentry error handler (before errorHandler) â”€
app.use(Sentry.Handlers.errorHandler());

// â”€â”€â”€ Global error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(errorHandler);

// â”€â”€â”€ WebSocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
initWebSocket(httpServer);

// â”€â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Graceful shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received â€” shutting down gracefully');
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



