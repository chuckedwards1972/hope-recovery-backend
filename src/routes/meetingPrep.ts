import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';

const router = Router();

const MeetingPrepSchema = z.object({
  meetingId: z.string().uuid(),
  identityDeclared: z.boolean().default(false),
  stepReflection: z.string().max(2000).optional(),
  scriptureInsight: z.string().max(2000).optional(),
  meetingFocus: z.string().max(2000).optional(),
  sessionReflection: z.string().max(2000).optional(),
});

// ─── POST /api/meeting-prep ──────────────────
// Submit a meeting prep card before attending
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = MeetingPrepSchema.parse(req.body);

    const meeting = await prisma.meeting.findUnique({ where: { id: data.meetingId } });
    if (!meeting) throw new AppError(404, 'Meeting not found');

    const prep = await prisma.meetingPrepSubmission.create({
      data: {
        id: uuid(),
        userId: req.user!.userId,
        meetingId: data.meetingId,
        campusId: req.user!.campusId,
        identityDeclared: data.identityDeclared,
        stepReflection: data.stepReflection,
        scriptureInsight: data.scriptureInsight,
        meetingFocus: data.meetingFocus,
        sessionReflection: data.sessionReflection,
      },
    });

    await logEvent({
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      eventType: 'MEETING_PREP_SUBMIT',
      metadata: {
        meetingId: data.meetingId,
        identityDeclared: data.identityDeclared,
        hasStepReflection: !!data.stepReflection,
        hasScriptureInsight: !!data.scriptureInsight,
      },
      ipAddress: req.ip,
    });

    res.status(201).json(prep);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/meeting-prep/prompt ────────────
// Returns the meeting prep prompt card for the next meeting
router.get('/prompt', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Find next upcoming meeting for user's campus
    const nextMeeting = await prisma.meeting.findFirst({
      where: {
        campusId: req.user!.campusId,
        isActive: true,
        meetingDate: { gte: new Date() },
      },
      orderBy: { meetingDate: 'asc' },
    });

    // Check if user already submitted prep for this meeting
    const alreadySubmitted = nextMeeting ? await prisma.meetingPrepSubmission.findFirst({
      where: { userId: req.user!.userId, meetingId: nextMeeting.id },
    }) : null;

    res.json({
      meeting: nextMeeting,
      alreadySubmitted: !!alreadySubmitted,
      prompt: {
        identityDeclaration: {
          title: 'Identity Declaration',
          text: 'We proudly introduce ourselves as Faithful Followers of Jesus Christ. We are no longer defined by fear or despair. From this moment forward, we move ahead without looking back at who we were — standing firmly in who we are now.',
        },
        questions: [
          {
            id: 'stepReflection',
            label: 'Step Reflection',
            prompt: 'Something I did or learned as I followed the 12 Steps this week.',
            placeholder: 'Share something from your step work this week...',
          },
          {
            id: 'scriptureInsight',
            label: 'Scripture Integration',
            prompt: 'What I learned from last session\'s key recovery scripture and how it applies to my path forward.',
            placeholder: 'How did last session\'s scripture speak to you?',
          },
          {
            id: 'meetingFocus',
            label: 'Meeting Focus',
            prompt: 'What last meeting\'s focus helped me understand.',
            placeholder: 'What stood out to you from the last meeting?',
          },
          {
            id: 'sessionReflection',
            label: 'Session Reflection',
            prompt: 'Last session\'s reflection helped me realize…',
            placeholder: 'Complete this sentence honestly...',
          },
        ],
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/meeting-prep/my-history ────────
router.get('/my-history', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const history = await prisma.meetingPrepSubmission.findMany({
      where: { userId: req.user!.userId },
      include: { meeting: { select: { title: true, meetingDate: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json(history);
  } catch (err) {
    next(err);
  }
});

export default router;
