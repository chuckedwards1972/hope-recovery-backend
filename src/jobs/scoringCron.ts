import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { computeAndPersistScores, computeSustainabilityIndex } from '../services/scoringService';
import { evaluateCampusLifecycle, dispatchRiskAlerts, sendWeeklyDigests } from '../services/lifecycleService';
import { triggerAlert } from '../services/eventService';
import { cacheDel, CacheKey } from '../lib/cache';
import { cronLogger } from '../lib/logger';

// ─── Nightly scoring job (2:00 AM) ───────────
export function startScoringCron() {
  cron.schedule('0 2 * * *', async () => {
    cronLogger.info('Starting nightly scoring run');
    const start = Date.now();
    let processed = 0;
    let errors = 0;

    try {
      const users = await prisma.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, campusId: true },
      });

      for (const user of users) {
        try {
          const scores = await computeAndPersistScores(user.id, 'nightly_cron');

          // Trigger risk alert if high risk
          if (scores.relapseRisk.level === 'HIGH') {
            await triggerAlert({
              campusId: user.campusId,
              memberId: user.id,
              memberName: user.id,
              type: 'relapse-risk',
              severity: 'critical',
              note: `Automated nightly score: ${scores.relapseRisk.signals?.join(', ')}`,
            });
          }

          processed++;
        } catch (err) {
          cronLogger.error({ err, userId: user.id }, 'Failed to score user');
          errors++;
        }
      }

      // Dispatch risk alerts to leaders
      const campuses = await prisma.campus.findMany({ select: { id: true } });
      for (const campus of campuses) {
        await dispatchRiskAlerts(campus.id);
      }

      // Invalidate analytics caches
      await cacheDel(CacheKey.campusStats(user.campusId) as any);
      await cacheDel(CacheKey.hqStats() as any);

      const duration = Date.now() - start;
      cronLogger.info({ processed, errors, duration: `${duration}ms` }, 'Nightly scoring complete');
    } catch (err) {
      cronLogger.error({ err }, 'Nightly scoring cron failed');
    }
  });

  cronLogger.info('Nightly scoring cron registered (2:00 AM daily)');
}

// ─── Weekly sustainability index (Sunday 3:00 AM) ─
export function startSustainabilityCron() {
  cron.schedule('0 3 * * 0', async () => {
    cronLogger.info('Starting weekly sustainability recalculation');
    const start = Date.now();

    try {
      const campuses = await prisma.campus.findMany({ select: { id: true, name: true } });

      for (const campus of campuses) {
        try {
          await computeSustainabilityIndex(campus.id);

          // Evaluate lifecycle transitions after sustainability update
          const result = await evaluateCampusLifecycle(campus.id);
          if (result.transitioned) {
            cronLogger.info({ campusId: campus.id, from: result.previous, to: result.current }, 'Campus lifecycle advanced');
          }

          // Invalidate campus cache
          await cacheDel(CacheKey.campusStats(campus.id) as any);
        } catch (err) {
          cronLogger.error({ err, campusId: campus.id }, 'Failed sustainability calc for campus');
        }
      }

      const duration = Date.now() - start;
      cronLogger.info({ campuses: campuses.length, duration: `${duration}ms` }, 'Sustainability recalculation complete');
    } catch (err) {
      cronLogger.error({ err }, 'Sustainability cron failed');
    }
  });

  cronLogger.info('Sustainability cron registered (Sunday 3:00 AM)');
}

// ─── Weekly digest emails (Monday 7:00 AM) ───
export function startDigestCron() {
  cron.schedule('0 7 * * 1', async () => {
    cronLogger.info('Sending weekly leader digests');
    try {
      await sendWeeklyDigests();
      cronLogger.info('Weekly digests sent');
    } catch (err) {
      cronLogger.error({ err }, 'Weekly digest cron failed');
    }
  });

  cronLogger.info('Weekly digest cron registered (Monday 7:00 AM)');
}

// ─── Lifecycle check (every 6 hours) ─────────
export function startLifecycleCron() {
  cron.schedule('0 */6 * * *', async () => {
    cronLogger.info('Running lifecycle evaluation pass');
    try {
      const campuses = await prisma.campus.findMany({ select: { id: true } });
      for (const campus of campuses) {
        await evaluateCampusLifecycle(campus.id);
      }
    } catch (err) {
      cronLogger.error({ err }, 'Lifecycle cron failed');
    }
  });

  cronLogger.info('Lifecycle cron registered (every 6 hours)');
}
