import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';
import { broadcastToCampus } from '../lib/websocket';

// ─────────────────────────────────────────────
// TESTIMONIES
// ─────────────────────────────────────────────
export const testimonyRouter = Router();

testimonyRouter.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN' ? undefined : req.user!.campusId;
    const filter = req.query.filter as string | undefined;

    let where: any = {};
    if (campusId) where.user = { campusId };

    if (filter === 'mine') {
      where.userId = req.user!.userId;
    } else if (filter === 'pending') {
      where.approved = false;
    } else {
      // 'all' or default: approved public + own
      where.OR = [
        { approved: true, isPublic: true },
        { userId: req.user!.userId },
      ];
    }

    const testimonies = await prisma.testimony.findMany({
      where,
      include: { user: { select: { id: true, name: true, campus: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const masked = testimonies.map((t) => ({
      ...t,
      user: t.isAnonymous && t.userId !== req.user!.userId
        ? { id: t.user.id, name: 'Anonymous', campus: t.user.campus }
        : t.user,
    }));

    res.json(masked);
  } catch (err) { next(err); }
});

testimonyRouter.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, isPublic, isAnonymous, mediaUrl } = req.body;
    if (!content?.trim()) throw new AppError(400, 'Testimony content required');

    const testimony = await prisma.testimony.create({
      data: {
        id: uuid(),
        userId: req.user!.userId,
        content,
        isPublic: isPublic || false,
        isAnonymous: isAnonymous || false,
        mediaUrl,
        approved: false,
      },
    });

    await logEvent({
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      eventType: 'TESTIMONY_SUBMIT',
      metadata: { testimonyId: testimony.id, isPublic, isAnonymous },
    });

    res.status(201).json(testimony);
  } catch (err) {
    next(err);
  }
});

testimonyRouter.patch('/:id/approve', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const testimony = await prisma.testimony.update({
      where: { id: req.params.id },
      data: { approved: true, approvedBy: req.user!.userId },
      include: {
        user: { select: { name: true, campusId: true } },
      },
    });

    // Real-time broadcast if public
    if (testimony.isPublic) {
      broadcastToCampus(testimony.user.campusId, {
        type: 'TESTIMONY_NEW',
        campusId: testimony.user.campusId,
        payload: {
          id: testimony.id,
          content: testimony.isAnonymous ? testimony.content : testimony.content,
          name: testimony.isAnonymous ? 'Anonymous' : testimony.user.name,
          createdAt: testimony.createdAt,
        },
      });
    }

    res.json(testimony);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────
export const analyticsRouter = Router();

analyticsRouter.get('/campus/:campusId', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;

    if (req.user!.role !== 'HQ_ADMIN' && campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus access denied');
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    const [
      memberCount,
      newMembersThisMonth,
      attendanceThisMonth,
      attendancePrevMonth,
      totalDonations,
      donationsThisMonth,
      housingOccupancy,
      eventBreakdown,
    ] = await Promise.all([
      prisma.user.count({ where: { campusId, status: 'ACTIVE' } }),
      prisma.user.count({ where: { campusId, joinedAt: { gte: thirtyDaysAgo } } }),
      prisma.attendance.count({ where: { meeting: { campusId }, checkinTime: { gte: thirtyDaysAgo } } }),
      prisma.attendance.count({ where: { meeting: { campusId }, checkinTime: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } } }),
      prisma.donation.aggregate({ where: { campusId, verificationStatus: 'VERIFIED' }, _sum: { amount: true } }),
      prisma.donation.aggregate({ where: { campusId, verificationStatus: 'VERIFIED', createdAt: { gte: thirtyDaysAgo } }, _sum: { amount: true } }),
      prisma.housingListing.aggregate({ where: { campusId }, _sum: { capacity: true, occupied: true } }),
      prisma.platformEvent.groupBy({ by: ['eventType'], where: { campusId, createdAt: { gte: thirtyDaysAgo } }, _count: true }),
    ]);

    const attendanceTrend = attendancePrevMonth > 0
      ? Math.round(((attendanceThisMonth - attendancePrevMonth) / attendancePrevMonth) * 100)
      : null;

    res.json({
      members: { total: memberCount, newThisMonth: newMembersThisMonth },
      attendance: { thisMonth: attendanceThisMonth, prevMonth: attendancePrevMonth, trend: attendanceTrend },
      donations: {
        allTime: totalDonations._sum.amount || 0,
        thisMonth: donationsThisMonth._sum.amount || 0,
      },
      housing: {
        capacity: housingOccupancy._sum.capacity || 0,
        occupied: housingOccupancy._sum.occupied || 0,
        occupancyRate: housingOccupancy._sum.capacity
          ? Math.round(((housingOccupancy._sum.occupied || 0) / housingOccupancy._sum.capacity) * 100)
          : 0,
      },
      events: eventBreakdown,
    });
  } catch (err) {
    next(err);
  }
});

// HQ Global analytics dashboard
analyticsRouter.get('/hq', authenticate, requireRole('HQ_ADMIN', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [campuses, totalMembers, totalAttendance, totalDonations, campusBreakdown] = await Promise.all([
      prisma.campus.findMany({ select: { id: true, name: true, lifecycleStage: true } }),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.attendance.count({ where: { checkinTime: { gte: thirtyDaysAgo } } }),
      prisma.donation.aggregate({ where: { verificationStatus: 'VERIFIED' }, _sum: { amount: true } }),
      prisma.campus.findMany({
        select: {
          id: true,
          name: true,
          lifecycleStage: true,
          _count: { select: { users: true } },
        },
      }),
    ]);

    res.json({
      campuses: campuses.length,
      totalMembers,
      totalAttendanceLast30Days: totalAttendance,
      totalDonationsAllTime: totalDonations._sum.amount || 0,
      campusBreakdown,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────
// PLATFORM EVENTS
// ─────────────────────────────────────────────
export const eventsRouter = Router();

eventsRouter.get('/user/:userId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isSelf = req.user!.userId === req.params.userId;
    const isLeader = ['HQ_ADMIN', 'CAMPUS_LEADER'].includes(req.user!.role);
    if (!isSelf && !isLeader) throw new AppError(403, 'Access denied');

    const events = await prisma.platformEvent.findMany({
      where: { userId: req.params.userId },
      orderBy: { createdAt: 'desc' },
      take: parseInt(req.query.limit as string) || 100,
    });

    res.json(events);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /:id/reject ────────────────────────
testimonyRouter.patch('/:id/reject', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.testimony.update({
      where: { id: req.params.id },
      data: { approved: false },
    });
    res.json(t);
  } catch (err) { next(err); }
});

// ─── GET with filter param ────────────────────
// The existing GET / supports ?filter=pending|mine|all
// Already handled by query logic above

export default testimonyRouter;
