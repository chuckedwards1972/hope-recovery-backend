import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireCampusAccess } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';
import { broadcastToCampus } from '../lib/websocket';

const router = Router();

const MeetingSchema = z.object({
  title: z.string().min(2),
  topic: z.string().optional(),
  location: z.string().optional(),
  meetingDate: z.string().datetime(),
  dayOfWeek: z.string().optional(),
  timeOfDay: z.string().optional(),
  isRecurring: z.boolean().default(false),
  chairId: z.string().uuid().optional(),
});

// ─── GET /api/meetings ────────────────────────
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? (req.query.campusId as string | undefined)
      : req.user!.campusId;

    const meetings = await prisma.meeting.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        isActive: true,
      },
      include: {
        chair: { select: { id: true, name: true } },
        campus: { select: { name: true, slug: true } },
        _count: { select: { attendances: true } },
      },
      orderBy: { meetingDate: 'desc' },
    });

    res.json(meetings);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/meetings ───────────────────────
router.post('/', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'GROUP_CHAIR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = MeetingSchema.parse(req.body);
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? (req.body.campusId || req.user!.campusId)
      : req.user!.campusId;

    const meeting = await prisma.meeting.create({
      data: {
        id: uuid(),
        campusId,
        ...data,
        meetingDate: new Date(data.meetingDate),
      },
    });

    res.status(201).json(meeting);
  } catch (err) {
    next(err);
  }
});

export default router;
