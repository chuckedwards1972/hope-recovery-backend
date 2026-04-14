import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireCampusAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// ─── GET /api/events (campus feed) ───────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { campusId, limit = '50', offset = '0', eventType } = req.query as any;
    const targetCampus = req.user!.role === 'HQ_ADMIN' ? campusId : req.user!.campusId;

    const where: any = {};
    if (targetCampus) where.campusId = targetCampus;
    if (eventType) where.eventType = eventType;

    const events = await prisma.platformEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    res.json(events);
  } catch (err) { next(err); }
});

// ─── GET /api/events/live (last 20 real-time) ─
router.get('/live', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN' ? undefined : req.user!.campusId;
    const events = await prisma.platformEvent.findMany({
      where: campusId ? { campusId } : {},
      orderBy: { occurredAt: 'desc' },
      take: 20,
      include: { user: { select: { id: true, name: true } } },
    });
    res.json(events);
  } catch (err) { next(err); }
});

// ─── GET /api/events/audit ───────────────────
router.get('/audit', requireRole('HQ_ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { limit = '50', offset = '0' } = req.query as any;
    const logs = await prisma.auditLog.findMany({
      orderBy: { performedAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
      include: { performer: { select: { id: true, name: true, role: true } } },
    });
    res.json(logs);
  } catch (err) { next(err); }
});

export { router as eventsRouter };
export default router;
