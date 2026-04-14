import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';

const router = Router();

const DonationConfirmSchema = z.object({
  campusId: z.string().uuid(),
  amount: z.number().positive(),
  campaign: z.string().optional(),
  zeffyReference: z.string().optional(),
  donorName: z.string().optional(),
  donorEmail: z.string().email().optional(),
  notes: z.string().optional(),
});

// ─── GET /api/donations/routing ──────────────
// Public endpoint — returns correct Zeffy link for a campus
router.get('/routing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.query;
    if (!campusId) throw new AppError(400, 'campusId required');

    const campus = await prisma.campus.findUnique({
      where: { id: campusId as string },
      include: { donationPool: true },
    });
    if (!campus) throw new AppError(404, 'Campus not found');

    // Routing logic:
    // 1. Campus has its own Zeffy link → use it (independent pool)
    // 2. Campus has a pool assigned → use pool link
    // 3. Default → POLR_CORE shared pool
    const zeffyLink =
      campus.zeffyLink ||
      campus.donationPool?.zeffyLink ||
      process.env.ZEFFY_POLR_CORE_LINK ||
      '';

    const poolType = campus.isSharedPool ? 'POLR_CORE' : 'INDEPENDENT';

    res.json({
      campusId: campus.id,
      campusName: campus.name,
      zeffyLink,
      poolType,
      lifecycleStage: campus.lifecycleStage,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/donations/confirm ─────────────
// Called after Zeffy payment completed to record confirmation
router.post('/confirm', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = DonationConfirmSchema.parse(req.body);

    // Verify campus exists and get pool assignment
    const campus = await prisma.campus.findUnique({
      where: { id: data.campusId },
      include: { donationPool: true },
    });
    if (!campus) throw new AppError(404, 'Campus not found');

    const donation = await prisma.donation.create({
      data: {
        id: uuid(),
        userId: req.user!.userId,
        campusId: data.campusId,
        poolId: campus.donationPoolId || undefined,
        amount: data.amount,
        campaign: data.campaign,
        zeffyReference: data.zeffyReference,
        donorName: data.donorName,
        donorEmail: data.donorEmail,
        notes: data.notes,
        verificationStatus: 'PENDING',
      },
    });

    await logEvent({
      userId: req.user!.userId,
      campusId: data.campusId,
      eventType: 'DONATION_MADE',
      metadata: {
        amount: data.amount,
        campaign: data.campaign,
        zeffyReference: data.zeffyReference,
        poolType: campus.isSharedPool ? 'POLR_CORE' : 'INDEPENDENT',
      },
      ipAddress: req.ip,
    });

    res.status(201).json(donation);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/donations ───────────────────────
// Campus leaders see their campus; HQ sees all
router.get('/', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? (req.query.campusId as string | undefined)
      : req.user!.campusId;

    const donations = await prisma.donation.findMany({
      where: { ...(campusId ? { campusId } : {}) },
      include: {
        user: { select: { id: true, name: true, email: true } },
        campus: { select: { name: true, slug: true } },
        pool: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(req.query.limit as string) || 50,
    });

    res.json(donations);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/donations/:id/verify ─────────
// HQ Admin or Campus Leader verifies a donation
router.patch('/:id/verify', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, notes } = req.body;
    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      throw new AppError(400, 'status must be VERIFIED or REJECTED');
    }

    const donation = await prisma.donation.findUnique({ where: { id: req.params.id } });
    if (!donation) throw new AppError(404, 'Donation not found');

    if (req.user!.role !== 'HQ_ADMIN' && donation.campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus access denied');
    }

    const updated = await prisma.donation.update({
      where: { id: req.params.id },
      data: {
        verificationStatus: status,
        verifiedBy: req.user!.userId,
        verifiedAt: new Date(),
        notes,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/donations/summary ──────────────
router.get('/summary', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? undefined
      : req.user!.campusId;

    const [total, verified, pending, byCampus] = await Promise.all([
      prisma.donation.aggregate({
        where: { ...(campusId ? { campusId } : {}) },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.donation.aggregate({
        where: { ...(campusId ? { campusId } : {}), verificationStatus: 'VERIFIED' },
        _sum: { amount: true },
      }),
      prisma.donation.count({
        where: { ...(campusId ? { campusId } : {}), verificationStatus: 'PENDING' },
      }),
      prisma.donation.groupBy({
        by: ['campusId'],
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    res.json({
      total: total._sum.amount || 0,
      totalCount: total._count,
      verified: verified._sum.amount || 0,
      pendingCount: pending,
      byCampus,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
