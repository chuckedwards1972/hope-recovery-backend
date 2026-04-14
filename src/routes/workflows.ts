import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireCampusAccess } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';
import { broadcastToCampus, broadcastToHQ } from '../lib/websocket';

const router = Router();

const WorkflowCreateSchema = z.object({
  type: z.enum(['LEADERSHIP_PROMOTION', 'HOUSING_PLACEMENT', 'WORKFORCE_CERT', 'CAMPUS_LAUNCH', 'DONATION_VERIFICATION', 'MEDIA_PUBLISH']),
  targetId: z.string().uuid().optional(),
  targetType: z.string().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ─── POST /api/workflows ─────────────────────
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = WorkflowCreateSchema.parse(req.body);

    const workflow = await prisma.approvalWorkflow.create({
      data: {
        id: uuid(),
        type: data.type,
        status: 'PENDING',
        requesterId: req.user!.userId,
        campusId: req.user!.campusId,
        targetId: data.targetId,
        targetType: data.targetType,
        notes: data.notes,
        metadata: data.metadata || {},
      },
      include: {
        requester: { select: { name: true, role: true } },
        campus: { select: { name: true } },
      },
    });

    // Notify campus leaders + HQ
    broadcastToCampus(req.user!.campusId, {
      type: 'LEADERSHIP_ALERTS',
      campusId: req.user!.campusId,
      payload: {
        alert: 'NEW_WORKFLOW',
        type: data.type,
        requester: workflow.requester.name,
        workflowId: workflow.id,
      },
    });

    if (data.type === 'CAMPUS_LAUNCH') {
      broadcastToHQ({
        type: 'CAMPUS_BROADCAST',
        payload: { alert: 'CAMPUS_LAUNCH_REQUEST', workflowId: workflow.id },
      });
    }

    res.status(201).json(workflow);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/workflows ───────────────────────
router.get('/', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN' ? undefined : req.user!.campusId;
    const status = req.query.status as string | undefined;

    const workflows = await prisma.approvalWorkflow.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        requester: { select: { id: true, name: true, role: true } },
        approver: { select: { id: true, name: true } },
        campus: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(workflows);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/workflows/:id/resolve ────────
router.patch('/:id/resolve', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER', 'AMBASSADOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, approverNote } = req.body;
    const validStatuses = ['APPROVED', 'REJECTED', 'NEEDS_REVIEW'];
    if (!validStatuses.includes(status)) throw new AppError(400, `status must be one of: ${validStatuses.join(', ')}`);

    const workflow = await prisma.approvalWorkflow.findUnique({ where: { id: req.params.id } });
    if (!workflow) throw new AppError(404, 'Workflow not found');

    if (req.user!.role !== 'HQ_ADMIN' && workflow.campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus access denied');
    }

    const updated = await prisma.approvalWorkflow.update({
      where: { id: req.params.id },
      data: {
        status,
        approverId: req.user!.userId,
        approverNote,
        resolvedAt: new Date(),
      },
    });

    // Auto-execute approved workflows
    if (status === 'APPROVED') {
      await executeApprovedWorkflow(updated, req.user!.userId);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Execute side-effects when a workflow is approved
async function executeApprovedWorkflow(workflow: any, approverId: string) {
  switch (workflow.type) {
    case 'LEADERSHIP_PROMOTION': {
      const { userId, newRole, newLevel } = workflow.metadata || {};
      if (userId && newRole) {
        await prisma.user.update({
          where: { id: userId },
          data: { role: newRole, level: newLevel ?? undefined },
        });
        await logEvent({
          userId,
          campusId: workflow.campusId,
          eventType: 'LEVEL_UP',
          metadata: { newRole, approvedBy: approverId, workflowId: workflow.id },
        });
      }
      break;
    }
    case 'HOUSING_PLACEMENT': {
      const { applicationId } = workflow.metadata || {};
      if (applicationId) {
        await prisma.housingApplication.update({
          where: { id: applicationId },
          data: { status: 'APPROVED', reviewedBy: approverId, reviewedAt: new Date() },
        });
      }
      break;
    }
    case 'CAMPUS_LAUNCH': {
      const { campusId, newLifecycle } = workflow.metadata || {};
      if (campusId && newLifecycle) {
        await prisma.campus.update({
          where: { id: campusId },
          data: { lifecycleStage: newLifecycle },
        });
        broadcastToHQ({
          type: 'CAMPUS_BROADCAST',
          payload: { alert: 'LIFECYCLE_CHANGE', campusId, newLifecycle },
        });
      }
      break;
    }
  }
}

export default router;
