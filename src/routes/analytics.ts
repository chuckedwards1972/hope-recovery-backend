import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireCampusAccess } from '../middleware/auth';
import { cacheGet, cacheSet, TTL, CacheKey } from '../lib/cache';

const router = Router();
router.use(authenticate);

// ─── GET /api/analytics/campus/:campusId ─────
router.get('/campus/:campusId', requireCampusAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;
    const cacheKey = CacheKey.campusStats(campusId) as any;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const [totalMembers, activeMembers, attendance30d, donations30d, donationsAllTime,
           testimonies, housingOccupancy, jobPlacements, scoringHighRisk] = await Promise.all([
      prisma.user.count({ where: { campusId, status: 'ACTIVE' } }),
      prisma.user.count({ where: { campusId, status: 'ACTIVE', lastLoginAt: { gte: thirtyDaysAgo } } }),
      prisma.attendance.count({ where: { meeting: { campusId }, attendedAt: { gte: thirtyDaysAgo } } }),
      prisma.donation.aggregate({ where: { campusId, status: 'CONFIRMED', createdAt: { gte: thirtyDaysAgo } }, _sum: { amount: true }, _count: true }),
      prisma.donation.aggregate({ where: { campusId, status: 'CONFIRMED' }, _sum: { amount: true }, _count: true }),
      prisma.testimony.count({ where: { user: { campusId }, approved: true, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.housingListing.aggregate({ where: { campusId }, _sum: { occupied: true, capacity: true } }),
      prisma.jobApplication.count({ where: { user: { campusId }, status: 'HIRED', updatedAt: { gte: ninetyDaysAgo } } }),
      prisma.scoringHistory.count({ where: { user: { campusId }, relapseRiskLevel: 'HIGH', recordedAt: { gte: thirtyDaysAgo } } }),
    ]);

    const result = {
      campusId,
      totalMembers,
      activeMembers,
      retentionRate: totalMembers > 0 ? Math.round((activeMembers / totalMembers) * 100) : 0,
      attendance30d,
      donations30d: { total: Number(donations30d._sum.amount || 0), count: donations30d._count },
      donationsAllTime: { total: Number(donationsAllTime._sum.amount || 0), count: donationsAllTime._count },
      testimonies30d: testimonies,
      housing: {
        occupied: housingOccupancy._sum.occupied || 0,
        capacity: housingOccupancy._sum.capacity || 0,
        rate: housingOccupancy._sum.capacity
          ? Math.round(((housingOccupancy._sum.occupied || 0) / housingOccupancy._sum.capacity) * 100)
          : 0,
      },
      jobPlacements90d: jobPlacements,
      highRiskMembers: scoringHighRisk,
      generatedAt: now.toISOString(),
    };

    await cacheSet(cacheKey, result, TTL.SHORT);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── GET /api/analytics/hq ───────────────────
router.get('/hq', requireRole('AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cached = await cacheGet(CacheKey.hqStats() as any);
    if (cached) return res.json(cached);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [campuses, totalMembers, totalAttendanceLast30Days, donationsAllTime] = await Promise.all([
      prisma.campus.findMany({
        include: {
          _count: { select: { users: true, meetings: true } },
          sustainabilityIndex: { orderBy: { calculatedAt: 'desc' }, take: 1 },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.attendance.count({ where: { attendedAt: { gte: thirtyDaysAgo } } }),
      prisma.donation.aggregate({ where: { status: 'CONFIRMED' }, _sum: { amount: true } }),
    ]);

    const result = {
      campuses: campuses.length,
      totalMembers,
      totalAttendanceLast30Days,
      totalDonationsAllTime: Number(donationsAllTime._sum.amount || 0),
      campusBreakdown: campuses.map((c) => ({
        id: c.id, name: c.name, slug: c.slug, lifecycleStage: c.lifecycleStage,
        city: c.city, state: c.state, _count: c._count,
        sustainabilityScore: c.sustainabilityIndex[0]?.overallScore || null,
      })),
      generatedAt: new Date().toISOString(),
    };

    await cacheSet(CacheKey.hqStats() as any, result, TTL.SHORT);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── GET /api/analytics/impact ───────────────
router.get('/impact', requireRole('AMBASSADOR'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [sobrietyMilestones, jobHires, housingPlacements, attendanceTotal, testimoniesApproved] = await Promise.all([
      prisma.user.count({ where: { sobrietyDate: { not: null }, status: 'ACTIVE' } }),
      prisma.jobApplication.count({ where: { status: 'HIRED' } }),
      prisma.housingApplication.count({ where: { status: 'APPROVED' } }),
      prisma.attendance.count(),
      prisma.testimony.count({ where: { approved: true } }),
    ]);
    res.json({ sobrietyMilestones, jobHires, housingPlacements, totalAttendance: attendanceTotal, approvedTestimonies: testimoniesApproved });
  } catch (err) { next(err); }
});

// ─── GET /api/analytics/retention/:campusId ──
router.get('/retention/:campusId', requireCampusAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;
    const cohorts = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date();
      start.setMonth(start.getMonth() - i - 1);
      start.setDate(1); start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      const joined = await prisma.user.count({ where: { campusId, joinedAt: { gte: start, lt: end } } });
      const retained = await prisma.user.count({ where: { campusId, joinedAt: { gte: start, lt: end }, status: 'ACTIVE', lastLoginAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } });
      cohorts.push({ month: start.toLocaleString('default', { month: 'short', year: 'numeric' }), joined, retained, rate: joined > 0 ? Math.round((retained / joined) * 100) : 0 });
    }
    res.json({ cohorts });
  } catch (err) { next(err); }
});

export { router as analyticsRouter };
export default router;
