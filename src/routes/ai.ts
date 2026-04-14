import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { generateInsight, generateDashboardInsights } from '../services/aiService';
import { computeAndPersistScores, computeSustainabilityIndex } from '../services/scoringService';
import { cacheGet, cacheSet, TTL } from '../lib/cache';

const router = Router();
router.use(authenticate);

// ─── POST /api/ai/insight ─────────────────────
// Generic insight endpoint — used by all frontend pages
router.post('/insight', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, data = {} } = req.body;
    if (!type) return res.status(400).json({ error: 'type is required' });

    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { name: true, campusId: true, role: true, campus: { select: { name: true } } },
    });

    const context = {
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      role: req.user!.role,
      userName: user?.name,
      campusName: user?.campus?.name,
    };

    const result = await generateInsight({ type, context, data });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── POST /api/ai/dashboard-insights ─────────
router.post('/dashboard-insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { name: true, campusId: true, role: true, campus: { select: { name: true } } },
    });

    const context = {
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      role: req.user!.role,
      userName: user?.name,
      campusName: user?.campus?.name,
    };

    const results = await generateDashboardInsights(context, req.body);
    res.json(results);
  } catch (err) { next(err); }
});

// ─── GET /api/ai/member/:userId ───────────────
router.get('/member/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    // Only self or leader
    if (req.user!.userId !== userId && !['CAMPUS_LEADER', 'AMBASSADOR', 'HQ_ADMIN'].includes(req.user!.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [scores, user] = await Promise.all([
      computeAndPersistScores(userId, 'AI_INSIGHT_REQUEST'),
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, campusId: true, role: true, campus: { select: { name: true } } },
      }),
    ]);

    const context = {
      userId,
      campusId: user?.campusId || req.user!.campusId,
      role: user?.role || 'MEMBER',
      userName: user?.name,
      campusName: user?.campus?.name,
    };

    const insight = await generateInsight({
      type: 'SCORING',
      context,
      data: {
        engagementScore: scores.engagement,
        relapseRiskLevel: scores.relapseRisk.level,
        signals: scores.relapseRisk.signals,
        leadershipReady: scores.leadership.ready,
        leadershipScore: scores.leadership.score,
      },
    });

    res.json({ scores, insight });
  } catch (err) { next(err); }
});

// ─── GET /api/ai/campus/:campusId ─────────────
router.get('/campus/:campusId', requireRole('CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;
    const sustainability = await computeSustainabilityIndex(campusId);

    const campus = await prisma.campus.findUnique({
      where: { id: campusId },
      select: { name: true, lifecycleStage: true },
    });

    const context = {
      userId: req.user!.userId,
      campusId,
      role: req.user!.role,
      campusName: campus?.name,
    };

    const insight = await generateInsight({
      type: 'SUSTAINABILITY',
      context,
      data: { ...sustainability, lifecycleStage: campus?.lifecycleStage, blockers: [] },
    });

    res.json({ sustainability, insight });
  } catch (err) { next(err); }
});

// ─── GET /api/ai/meeting-prep/:meetingId ──────
router.get('/meeting-prep/:meetingId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meetingId } = req.params;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [meeting, recentAttendance, highRiskCount] = await Promise.all([
      prisma.meeting.findUnique({ where: { id: meetingId }, include: { campus: { select: { name: true } } } }),
      prisma.attendance.count({ where: { meetingId, attendedAt: { gte: thirtyDaysAgo } } }),
      prisma.scoringHistory.count({ where: { user: { campusId: req.user!.campusId }, relapseRiskLevel: 'HIGH', recordedAt: { gte: thirtyDaysAgo } } }),
    ]);

    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const context = {
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      role: req.user!.role,
      campusName: meeting.campus?.name,
    };

    const insight = await generateInsight({
      type: 'MEETING_PREP',
      context,
      data: { meeting, recentAttendance, highRiskCount, stepFocus: meeting.topic },
    });

    res.json({ meeting, insight });
  } catch (err) { next(err); }
});

export default router;
