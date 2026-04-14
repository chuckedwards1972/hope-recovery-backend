import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';
import { evaluateCampusLifecycle, LIFECYCLE_THRESHOLDS, LIFECYCLE_UNLOCKS, isCampusFeatureUnlocked } from '../services/lifecycleService';
import { broadcastToHQ } from '../lib/websocket';

const router = Router();
router.use(authenticate);

// ─── POST /api/expansion/launch-request ──────
// Initiates CAMPUS_LAUNCH approval workflow
const LaunchRequestSchema = z.object({
  proposedName: z.string().min(3).max(100),
  city: z.string().min(2),
  state: z.string().length(2),
  proposedLeaderId: z.string().uuid(),
  sponsoringCampusId: z.string().uuid(),
  rationale: z.string().min(50).max(2000),
  projectedMembers: z.number().int().min(3).max(200),
  meetingLocation: z.string().min(5),
});

router.post('/launch-request', requireRole('AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = LaunchRequestSchema.parse(req.body);

    // Verify sponsoring campus is MULTIPLYING
    const sponsoring = await prisma.campus.findUnique({ where: { id: data.sponsoringCampusId } });
    if (!sponsoring) throw new AppError(404, 'Sponsoring campus not found');
    if (!isCampusFeatureUnlocked(sponsoring.lifecycleStage, 'campus_launch')) {
      throw new AppError(403, `Sponsoring campus must be in MULTIPLYING stage (currently ${sponsoring.lifecycleStage})`);
    }

    // Verify proposed leader exists and is qualified
    const leader = await prisma.user.findUnique({ where: { id: data.proposedLeaderId } });
    if (!leader) throw new AppError(404, 'Proposed leader not found');
    if (!['CAMPUS_LEADER', 'AMBASSADOR', 'HQ_ADMIN'].includes(leader.role)) {
      throw new AppError(403, 'Proposed leader must hold CAMPUS_LEADER role or above');
    }

    // Create approval workflow
    const workflow = await prisma.approvalWorkflow.create({
      data: {
        id: uuid(),
        type: 'CAMPUS_LAUNCH',
        requestedById: req.user!.userId,
        status: 'PENDING',
        metadata: {
          proposedName: data.proposedName,
          city: data.city,
          state: data.state,
          proposedLeaderId: data.proposedLeaderId,
          proposedLeaderName: leader.name,
          sponsoringCampusId: data.sponsoringCampusId,
          sponsoringCampusName: sponsoring.name,
          rationale: data.rationale,
          projectedMembers: data.projectedMembers,
          meetingLocation: data.meetingLocation,
        },
      },
    });

    await logEvent({
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      eventType: 'WORKFLOW_CREATED' as any,
      metadata: { workflowId: workflow.id, type: 'CAMPUS_LAUNCH', proposedName: data.proposedName },
    });

    broadcastToHQ({ type: 'campus_launch_request', payload: { workflowId: workflow.id, proposedName: data.proposedName } });

    res.status(201).json(workflow);
  } catch (err) { next(err); }
});

// ─── POST /api/expansion/launch-request/:id/approve ──
router.post('/launch-request/:id/approve', requireRole('HQ_ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workflow = await prisma.approvalWorkflow.findUnique({ where: { id: req.params.id } });
    if (!workflow) throw new AppError(404, 'Workflow not found');
    if (workflow.status !== 'PENDING') throw new AppError(400, 'Workflow already resolved');
    if (workflow.type !== 'CAMPUS_LAUNCH') throw new AppError(400, 'Not a campus launch workflow');

    const meta = workflow.metadata as any;

    // Create the new campus
    const slug = meta.proposedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newCampus = await prisma.campus.create({
      data: {
        id: uuid(),
        name: meta.proposedName,
        slug,
        city: meta.city,
        state: meta.state,
        lifecycleStage: 'LAUNCHING',
        sponsoringCampusId: meta.sponsoringCampusId,
        approvedBy: req.user!.userId,
      },
    });

    // Assign the proposed leader to the new campus
    await prisma.user.update({
      where: { id: meta.proposedLeaderId },
      data: { campusId: newCampus.id, role: 'CAMPUS_LEADER' },
    });

    // Update workflow
    await prisma.approvalWorkflow.update({
      where: { id: workflow.id },
      data: { status: 'APPROVED', resolvedById: req.user!.userId, resolvedAt: new Date() },
    });

    await logEvent({
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      eventType: 'CAMPUS_LAUNCHED' as any,
      metadata: { newCampusId: newCampus.id, name: newCampus.name },
    });

    broadcastToHQ({ type: 'campus_launched', payload: { campusId: newCampus.id, name: newCampus.name } });

    res.json({ campus: newCampus, message: `Campus "${newCampus.name}" launched successfully` });
  } catch (err) { next(err); }
});

// ─── POST /api/expansion/assign-mentor ───────
router.post('/assign-mentor', requireRole('CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { mentorId, menteeId } = z.object({
      mentorId: z.string().uuid(),
      menteeId: z.string().uuid(),
    }).parse(req.body);

    const [mentor, mentee] = await Promise.all([
      prisma.user.findUnique({ where: { id: mentorId } }),
      prisma.user.findUnique({ where: { id: menteeId } }),
    ]);

    if (!mentor || !mentee) throw new AppError(404, 'User not found');

    await prisma.user.update({ where: { id: menteeId }, data: { mentorId } });

    await logEvent({
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      eventType: 'MENTOR_ASSIGNED' as any,
      metadata: { mentorId, mentorName: mentor.name, menteeId, menteeName: mentee.name },
    });

    res.json({ success: true, mentor: mentor.name, mentee: mentee.name });
  } catch (err) { next(err); }
});

// ─── GET /api/expansion/readiness/:campusId ──
router.get('/readiness/:campusId', requireRole('AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId } = req.params;
    const result = await evaluateCampusLifecycle(campusId);

    const campus = await prisma.campus.findUnique({
      where: { id: campusId },
      include: {
        _count: { select: { users: true, meetings: true } },
        sustainabilityIndex: { orderBy: { calculatedAt: 'desc' }, take: 1 },
      },
    });

    res.json({
      campusId,
      currentStage: result.current,
      previousStage: result.previous,
      justTransitioned: result.transitioned,
      blockers: result.blockers,
      unlockedFeatures: LIFECYCLE_UNLOCKS[result.current] || [],
      thresholds: LIFECYCLE_THRESHOLDS,
      stats: {
        memberCount: campus?._count.users || 0,
        meetingCount: campus?._count.meetings || 0,
        sustainabilityScore: campus?.sustainabilityIndex[0]?.overallScore || 0,
      },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/expansion/sub-campus-template ──
router.get('/sub-campus-template', requireRole('AMBASSADOR'), (_req, res) => {
  res.json({
    requiredFields: ['proposedName', 'city', 'state', 'proposedLeaderId', 'sponsoringCampusId', 'rationale', 'projectedMembers', 'meetingLocation'],
    checklist: [
      { id: 1, item: 'Sponsoring campus confirmed at MULTIPLYING stage', required: true },
      { id: 2, item: 'Proposed leader identified and vetted', required: true },
      { id: 3, item: 'Meeting location secured', required: true },
      { id: 4, item: 'Launch team of 3+ committed members', required: true },
      { id: 5, item: 'First 4 meetings scheduled', required: true },
      { id: 6, item: 'HQ approval workflow submitted', required: true },
      { id: 7, item: 'Zeffy donation pool created for new campus', required: false },
      { id: 8, item: 'Welcome packet prepared for new members', required: false },
    ],
  });
});

export default router;
