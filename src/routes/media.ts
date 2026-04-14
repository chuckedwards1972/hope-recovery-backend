import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';
import { broadcastToCampus, broadcastToHQ } from '../lib/websocket';

const router = Router();

const MediaCreateSchema = z.object({
  type: z.enum(['PODCAST', 'VLOG', 'TEACHING', 'ANNOUNCEMENT']),
  title: z.string().min(2).max(200),
  description: z.string().optional(),
  fileUrl: z.string().url().optional(),
  fileKey: z.string().optional(),
  thumbnailUrl: z.string().url().optional(),
  duration: z.number().int().optional(),
  tags: z.array(z.string()).default([]),
  campusId: z.string().uuid().optional(), // null = global broadcast
});

// ─── GET /api/media ───────────────────────────
// Role-filtered: members see PUBLISHED; leaders see all
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isLeader = ['HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'].includes(req.user!.role);
    const type = req.query.type as string | undefined;

    const media = await prisma.mediaItem.findMany({
      where: {
        ...(isLeader ? {} : { status: 'PUBLISHED' }),
        // Members see global + their campus content
        ...(isLeader ? {} : {
          OR: [
            { campusId: null },
            { campusId: req.user!.campusId },
          ],
        }),
        ...(type ? { type } : {}),
      },
      include: {
        author: { select: { name: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(req.query.limit as string) || 50,
    });

    res.json(media);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/media ──────────────────────────
router.post('/', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = MediaCreateSchema.parse(req.body);

    const media = await prisma.mediaItem.create({
      data: {
        id: uuid(),
        type: data.type,
        status: 'DRAFT',
        title: data.title,
        description: data.description,
        fileUrl: data.fileUrl,
        fileKey: data.fileKey,
        thumbnailUrl: data.thumbnailUrl,
        duration: data.duration,
        tags: data.tags,
        campusId: data.campusId || null,
        authorId: req.user!.userId,
      },
    });

    res.status(201).json(media);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/media/:id/submit ─────────────
// Submit for approval
router.patch('/:id/submit', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const media = await prisma.mediaItem.findUnique({ where: { id: req.params.id } });
    if (!media) throw new AppError(404, 'Media item not found');
    if (media.authorId !== req.user!.userId && req.user!.role !== 'HQ_ADMIN') {
      throw new AppError(403, 'Only the author or HQ Admin can submit this item');
    }

    const updated = await prisma.mediaItem.update({
      where: { id: req.params.id },
      data: { status: 'PENDING_APPROVAL' },
    });

    // Create approval workflow
    await prisma.approvalWorkflow.create({
      data: {
        id: uuid(),
        type: 'MEDIA_PUBLISH',
        status: 'PENDING',
        requesterId: req.user!.userId,
        campusId: req.user!.campusId,
        targetId: media.id,
        targetType: 'MediaItem',
        notes: `Approval requested for ${media.type}: "${media.title}"`,
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/media/:id/publish ────────────
router.patch('/:id/publish', authenticate, requireRole('HQ_ADMIN', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const media = await prisma.mediaItem.update({
      where: { id: req.params.id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        approvedBy: req.user!.userId,
      },
    });

    // Broadcast new media announcement
    if (media.campusId) {
      broadcastToCampus(media.campusId, {
        type: 'CAMPUS_BROADCAST',
        campusId: media.campusId,
        payload: { alert: 'NEW_MEDIA', type: media.type, title: media.title, id: media.id },
      });
    } else {
      broadcastToHQ({
        type: 'CAMPUS_BROADCAST',
        payload: { alert: 'NEW_MEDIA_GLOBAL', type: media.type, title: media.title, id: media.id },
      });
    }

    res.json(media);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/media/:id/play ─────────────────
// Track a play event
router.post('/:id/play', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await Promise.all([
      prisma.mediaItem.update({
        where: { id: req.params.id },
        data: { plays: { increment: 1 } },
      }),
      logEvent({
        userId: req.user!.userId,
        campusId: req.user!.campusId,
        eventType: 'MEDIA_PLAY',
        metadata: { mediaId: req.params.id },
      }),
    ]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/media/analytics ────────────────
router.get('/analytics', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [byType, topItems, totalPlays] = await Promise.all([
      prisma.mediaItem.groupBy({
        by: ['type'],
        where: { status: 'PUBLISHED' },
        _count: true,
        _sum: { plays: true },
      }),
      prisma.mediaItem.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: { plays: 'desc' },
        take: 10,
        select: { id: true, title: true, type: true, plays: true, publishedAt: true },
      }),
      prisma.mediaItem.aggregate({
        where: { status: 'PUBLISHED' },
        _sum: { plays: true },
      }),
    ]);

    res.json({ byType, topItems, totalPlays: totalPlays._sum.plays || 0 });
  } catch (err) {
    next(err);
  }
});

export default router;
