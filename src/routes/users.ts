import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireSelfOrLeader } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';
import { computeEngagementScore, computeRelapseRisk, computeLeadershipReadiness } from '../services/eventService';

const router = Router();

const UpdateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  bio: z.string().max(500).optional(),
  sobrietyDate: z.string().datetime().optional(),
});

// ─── GET /api/users ───────────────────────────
// Leaders see their campus members; HQ sees all
router.get('/', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'GROUP_CHAIR', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? (req.query.campusId as string | undefined)
      : req.user!.campusId;

    const users = await prisma.user.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        status: { not: 'SUSPENDED' },
      },
      select: {
        id: true, name: true, email: true, role: true, level: true,
        campusId: true, status: true, joinedAt: true, lastLoginAt: true,
        campus: { select: { name: true, slug: true } },
      },
      orderBy: { name: 'asc' },
    });

    res.json(users);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/users/:userId ───────────────────
router.get('/:userId', authenticate, requireSelfOrLeader, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: {
        id: true, name: true, email: true, role: true, level: true,
        campusId: true, status: true, phone: true, bio: true,
        sobrietyDate: true, joinedAt: true, lastLoginAt: true, avatarUrl: true,
        campus: { select: { id: true, name: true, slug: true } },
        certifications: true,
        _count: { select: { attendances: true, donations: true } },
      },
    });

    if (!user) throw new AppError(404, 'User not found');
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/users/:userId ─────────────────
router.patch('/:userId', authenticate, requireSelfOrLeader, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = UpdateProfileSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.params.userId },
      data: {
        ...data,
        sobrietyDate: data.sobrietyDate ? new Date(data.sobrietyDate) : undefined,
      },
      select: {
        id: true, name: true, email: true, role: true, level: true,
        campusId: true, phone: true, bio: true, sobrietyDate: true,
      },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/users/:userId/role ────────────
router.patch('/:userId/role', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { role, level } = req.body;

    // Campus leaders can only promote within their campus, not to HQ_ADMIN
    if (req.user!.role === 'CAMPUS_LEADER' && role === 'HQ_ADMIN') {
      throw new AppError(403, 'Campus leaders cannot assign HQ_ADMIN role');
    }

    const targetUser = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!targetUser) throw new AppError(404, 'User not found');

    if (req.user!.role !== 'HQ_ADMIN' && targetUser.campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus role assignment not permitted');
    }

    const oldLevel = targetUser.level;

    const updated = await prisma.user.update({
      where: { id: req.params.userId },
      data: { role, level: level ?? targetUser.level },
    });

    if (level !== undefined && level !== oldLevel) {
      await prisma.levelHistory.create({
        data: {
          userId: req.params.userId,
          fromLevel: oldLevel,
          toLevel: level,
          reason: req.body.reason,
          grantedBy: req.user!.userId,
        },
      });

      await logEvent({
        userId: req.params.userId,
        campusId: targetUser.campusId,
        eventType: 'LEVEL_UP',
        metadata: { fromLevel: oldLevel, toLevel: level, grantedBy: req.user!.userId },
      });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/users/:userId/ai-profile ───────
router.get('/:userId/ai-profile', authenticate, requireSelfOrLeader, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [engagement, relapseRisk, leadership] = await Promise.all([
      computeEngagementScore(req.params.userId),
      computeRelapseRisk(req.params.userId),
      computeLeadershipReadiness(req.params.userId),
    ]);

    res.json({ engagement, relapseRisk, leadership });
  } catch (err) {
    next(err);
  }
});

export default router;
