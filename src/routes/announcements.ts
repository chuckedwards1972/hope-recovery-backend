import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { broadcastToCampus, broadcastToHQ } from '../lib/websocket';

const router = Router();

// We reuse the MediaItem model with type=ANNOUNCEMENT
// This route provides a cleaner API surface for announcements specifically

const AnnouncementSchema = z.object({
  title: z.string().min(2).max(200),
  content: z.string().min(2),
  campusId: z.string().uuid().optional(), // null = all campuses
  priority: z.enum(['normal', 'urgent', 'critical']).default('normal'),
  expiresAt: z.string().datetime().optional(),
});

// ─── GET /api/announcements ───────────────────
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? undefined
      : req.user!.campusId;

    const announcements = await prisma.mediaItem.findMany({
      where: {
        type: 'ANNOUNCEMENT',
        status: 'PUBLISHED',
        OR: [
          { campusId: null },
          ...(campusId ? [{ campusId }] : []),
        ],
      },
      include: {
        author: { select: { name: true, role: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    });

    res.json(announcements);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/announcements ──────────────────
router.post('/', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = AnnouncementSchema.parse(req.body);

    const campusId = req.user!.role === 'HQ_ADMIN'
      ? (data.campusId || null)
      : req.user!.campusId;

    const announcement = await prisma.mediaItem.create({
      data: {
        id: uuid(),
        type: 'ANNOUNCEMENT',
        status: 'PUBLISHED', // announcements skip the approval queue
        title: data.title,
        description: data.content,
        tags: [data.priority],
        campusId,
        authorId: req.user!.userId,
        publishedAt: new Date(),
        approvedBy: req.user!.userId,
      },
    });

    // Broadcast via WebSocket
    const broadcastPayload = {
      type: 'CAMPUS_BROADCAST' as const,
      campusId: campusId || undefined,
      payload: {
        alert: 'NEW_ANNOUNCEMENT',
        id: announcement.id,
        title: data.title,
        priority: data.priority,
        author: req.user!.email,
      },
    };

    if (campusId) {
      broadcastToCampus(campusId, broadcastPayload);
    } else {
      broadcastToHQ(broadcastPayload);
    }

    res.status(201).json(announcement);
  } catch (err) {
    next(err);
  }
});

export default router;
