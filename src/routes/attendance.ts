import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';
import { broadcastToCampus } from '../lib/websocket';

const router = Router();

const CheckInSchema = z.object({
  meetingId: z.string().uuid(),
  userId: z.string().uuid(),
  notes: z.string().optional(),
});

// ─── POST /api/attendance/checkin ────────────
// Group chairs and campus leaders check in members
router.post('/checkin', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'GROUP_CHAIR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = CheckInSchema.parse(req.body);

    // Verify meeting belongs to same campus
    const meeting = await prisma.meeting.findUnique({
      where: { id: data.meetingId },
    });
    if (!meeting) throw new AppError(404, 'Meeting not found');

    if (req.user!.role !== 'HQ_ADMIN' && meeting.campusId !== req.user!.campusId) {
      throw new AppError(403, 'Meeting belongs to a different campus');
    }

    // Upsert — idempotent check-in
    const attendance = await prisma.attendance.upsert({
      where: { meetingId_userId: { meetingId: data.meetingId, userId: data.userId } },
      create: {
        id: uuid(),
        meetingId: data.meetingId,
        userId: data.userId,
        notes: data.notes,
      },
      update: { notes: data.notes },
      include: {
        user: { select: { id: true, name: true, level: true } },
      },
    });

    // Log event for AI scoring
    await logEvent({
      userId: data.userId,
      campusId: meeting.campusId,
      eventType: 'MEETING_ATTEND',
      metadata: { meetingId: data.meetingId, meetingTitle: meeting.title },
      ipAddress: req.ip,
    });

    // Real-time broadcast to campus
    broadcastToCampus(meeting.campusId, {
      type: 'ATTENDANCE_UPDATE',
      campusId: meeting.campusId,
      payload: {
        meetingId: data.meetingId,
        user: attendance.user,
        checkinTime: attendance.checkinTime,
      },
    });

    res.status(201).json(attendance);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/attendance/meeting/:meetingId ───
router.get('/meeting/:meetingId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: req.params.meetingId },
    });
    if (!meeting) throw new AppError(404, 'Meeting not found');

    if (req.user!.role !== 'HQ_ADMIN' && meeting.campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus access denied');
    }

    const attendances = await prisma.attendance.findMany({
      where: { meetingId: req.params.meetingId },
      include: {
        user: { select: { id: true, name: true, role: true, level: true, avatarUrl: true } },
      },
      orderBy: { checkinTime: 'asc' },
    });

    res.json(attendances);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/attendance/user/:userId ─────────
router.get('/user/:userId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Users can view their own; leaders can view anyone in their campus
    const isSelf = req.user!.userId === req.params.userId;
    const isLeader = ['HQ_ADMIN', 'CAMPUS_LEADER', 'GROUP_CHAIR'].includes(req.user!.role);
    if (!isSelf && !isLeader) throw new AppError(403, 'Access denied');

    const limit = parseInt(req.query.limit as string) || 30;

    const attendances = await prisma.attendance.findMany({
      where: { userId: req.params.userId },
      include: {
        meeting: { select: { id: true, title: true, meetingDate: true, campus: { select: { name: true } } } },
      },
      orderBy: { checkinTime: 'desc' },
      take: limit,
    });

    res.json(attendances);
  } catch (err) {
    next(err);
  }
});

export default router;
