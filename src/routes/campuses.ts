import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireCampusAccess } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

const CampusCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  city: z.string().optional(),
  state: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  zeffyLink: z.string().url().optional(),
  isSharedPool: z.boolean().default(true),
});

// ─── GET /api/campuses ────────────────────────
// HQ_ADMIN: all campuses. Others: their own campus only.
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isAdmin = req.user!.role === 'HQ_ADMIN';

    const campuses = await prisma.campus.findMany({
      where: isAdmin ? {} : { id: req.user!.campusId },
      include: {
        _count: { select: { users: true, meetings: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(campuses);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/campuses/:campusId ──────────────
router.get('/:campusId', authenticate, requireCampusAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campus = await prisma.campus.findUnique({
      where: { id: req.params.campusId },
      include: {
        donationPool: true,
        _count: { select: { users: true, meetings: true, donations: true } },
      },
    });

    if (!campus) throw new AppError(404, 'Campus not found');
    res.json(campus);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/campuses ───────────────────────
router.post('/', authenticate, requireRole('HQ_ADMIN', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = CampusCreateSchema.parse(req.body);

    const campus = await prisma.campus.create({
      data: {
        id: uuid(),
        ...data,
        lifecycleStage: 'PLANNING',
      },
    });

    res.status(201).json(campus);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/campuses/:campusId ────────────
router.patch('/:campusId', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), requireCampusAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campus = await prisma.campus.update({
      where: { id: req.params.campusId },
      data: req.body,
    });

    res.json(campus);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/campuses/:campusId/donation-link ─
// Returns the correct Zeffy link based on campus pool assignment
router.get('/:campusId/donation-link', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campus = await prisma.campus.findUnique({
      where: { id: req.params.campusId },
      include: { donationPool: true },
    });

    if (!campus) throw new AppError(404, 'Campus not found');

    // Port Allen has independent pool
    // Campuses in SUSTAINABLE+ get independent pools
    // All others share POLR_CORE
    let zeffyLink: string;
    if (campus.zeffyLink) {
      zeffyLink = campus.zeffyLink;
    } else if (campus.donationPool?.zeffyLink) {
      zeffyLink = campus.donationPool.zeffyLink;
    } else {
      // Fall back to POLR_CORE
      zeffyLink = process.env.ZEFFY_POLR_CORE_LINK || '';
    }

    res.json({
      campusId: campus.id,
      campusName: campus.name,
      zeffyLink,
      poolType: campus.isSharedPool ? 'POLR_CORE' : 'INDEPENDENT',
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/campuses/:campusId/stats ────────
router.get('/:campusId/stats', authenticate, requireCampusAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [memberCount, attendanceCount, donationSum, housingOccupied, openJobs] = await Promise.all([
      prisma.user.count({ where: { campusId, status: 'ACTIVE' } }),
      prisma.attendance.count({
        where: { meeting: { campusId }, checkinTime: { gte: thirtyDaysAgo } },
      }),
      prisma.donation.aggregate({
        where: { campusId, verificationStatus: 'VERIFIED' },
        _sum: { amount: true },
      }),
      prisma.housingListing.aggregate({
        where: { campusId },
        _sum: { occupied: true },
      }),
      prisma.job.count({ where: { campusId, isActive: true } }),
    ]);

    res.json({
      members: memberCount,
      attendanceLast30Days: attendanceCount,
      totalDonations: donationSum._sum.amount || 0,
      housingOccupied: housingOccupied._sum.occupied || 0,
      openJobs,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
