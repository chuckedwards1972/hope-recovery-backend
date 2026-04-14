import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireSelfOrLeader } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { computeAndPersistScores, computeSustainabilityIndex } from '../services/scoringService';

const router = Router();

// ─── GET /api/scoring/user/:userId ───────────
// Full AI profile with current scores + trend
router.get('/user/:userId', authenticate, requireSelfOrLeader, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Get current scores (also persists to history)
    const current = await computeAndPersistScores(userId, 'MANUAL_REFRESH');

    // Get trend history
    const history = await prisma.scoringHistory.findMany({
      where: { userId, computedAt: { gte: since } },
      orderBy: { computedAt: 'asc' },
      select: {
        engagementScore: true,
        relapseRisk: true,
        relapseLevel: true,
        leadershipScore: true,
        leadershipReady: true,
        certProgress: true,
        triggeredBy: true,
        computedAt: true,
      },
    });

    // Get event breakdown for the period
    const eventBreakdown = await prisma.platformEvent.groupBy({
      by: ['eventType'],
      where: { userId, createdAt: { gte: since } },
      _count: true,
    });

    res.json({
      current,
      trend: history,
      eventBreakdown,
      period: { days, since },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/scoring/user/:userId/refresh ──
// Force-recompute scores (leaders can do this for their members)
router.post('/user/:userId/refresh', authenticate, requireSelfOrLeader, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scores = await computeAndPersistScores(req.params.userId, 'LEADER_REFRESH');
    res.json(scores);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/scoring/campus/:campusId ───────
// Campus-level risk alerts dashboard
router.get('/campus/:campusId', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;

    if (req.user!.role !== 'HQ_ADMIN' && campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus access denied');
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Members with HIGH/CRITICAL relapse risk (no login in 7 days)
    const atRiskMembers = await prisma.user.findMany({
      where: {
        campusId,
        status: 'ACTIVE',
        role: 'MEMBER',
        lastLoginAt: { lt: sevenDaysAgo },
      },
      select: {
        id: true,
        name: true,
        lastLoginAt: true,
        _count: { select: { attendances: true } },
      },
      take: 20,
    });

    // Leadership pipeline — members at level 5 with high engagement
    const leadershipCandidates = await prisma.scoringHistory.findMany({
      where: {
        user: { campusId, role: 'MEMBER' },
        leadershipScore: { gte: 60 },
        computedAt: { gte: sevenDaysAgo },
      },
      include: {
        user: { select: { id: true, name: true, level: true } },
      },
      orderBy: { leadershipScore: 'desc' },
      take: 10,
    });

    // Sustainability index
    const sustainability = await computeSustainabilityIndex(campusId);

    res.json({
      atRiskMembers: atRiskMembers.map((m) => ({
        ...m,
        daysSinceLogin: m.lastLoginAt
          ? Math.floor((Date.now() - new Date(m.lastLoginAt).getTime()) / (1000 * 60 * 60 * 24))
          : null,
      })),
      leadershipCandidates,
      sustainability,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/scoring/campus/:campusId/sustainability ─
router.get('/campus/:campusId/sustainability', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;
    if (req.user!.role !== 'HQ_ADMIN' && campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus access denied');
    }

    const [current, history] = await Promise.all([
      computeSustainabilityIndex(campusId),
      prisma.campusSustainabilityIndex.findMany({
        where: { campusId },
        orderBy: { computedAt: 'asc' },
      }),
    ]);

    res.json({ current, history });
  } catch (err) {
    next(err);
  }
});

export default router;
