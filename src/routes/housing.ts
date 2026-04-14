import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';

const router = Router();

const ListingSchema = z.object({
  partnerName: z.string().min(2),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  capacity: z.number().int().positive(),
  housingType: z.enum(['Men', 'Women', 'Mixed', 'Family']).optional(),
  description: z.string().optional(),
  requirements: z.string().optional(),
});

// ─── GET /api/housing/listings ────────────────
router.get('/listings', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? (req.query.campusId as string | undefined)
      : req.user!.campusId;

    const listings = await prisma.housingListing.findMany({
      where: { ...(campusId ? { campusId } : {}), isActive: true },
      include: {
        campus: { select: { name: true } },
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(listings);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/housing/listings ───────────────
router.post('/listings', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = ListingSchema.parse(req.body);
    const campusId = req.user!.role === 'HQ_ADMIN'
      ? (req.body.campusId || req.user!.campusId)
      : req.user!.campusId;

    const listing = await prisma.housingListing.create({
      data: { id: uuid(), campusId, ...data },
    });

    res.status(201).json(listing);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/housing/listings/:listingId/apply ─
router.post('/listings/:listingId/apply', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const listing = await prisma.housingListing.findUnique({
      where: { id: req.params.listingId },
    });
    if (!listing || !listing.isActive) throw new AppError(404, 'Listing not found or unavailable');

    if (listing.occupied >= listing.capacity) {
      throw new AppError(409, 'No beds available at this location');
    }

    const existing = await prisma.housingApplication.findFirst({
      where: {
        listingId: req.params.listingId,
        userId: req.user!.userId,
        status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
      },
    });
    if (existing) throw new AppError(409, 'You already have a pending application for this listing');

    const application = await prisma.housingApplication.create({
      data: {
        id: uuid(),
        listingId: req.params.listingId,
        userId: req.user!.userId,
        moveInDate: req.body.moveInDate ? new Date(req.body.moveInDate) : undefined,
        notes: req.body.notes,
        status: 'SUBMITTED',
      },
    });

    await logEvent({
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      eventType: 'HOUSING_APPLY',
      metadata: { listingId: req.params.listingId, partnerName: listing.partnerName },
      ipAddress: req.ip,
    });

    res.status(201).json(application);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/housing/applications/:id/status ─
router.patch('/applications/:id/status', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, notes } = req.body;
    const validStatuses = ['UNDER_REVIEW', 'APPROVED', 'REJECTED'];
    if (!validStatuses.includes(status)) throw new AppError(400, `Invalid status`);

    const app = await prisma.housingApplication.findUnique({
      where: { id: req.params.id },
      include: { listing: true },
    });
    if (!app) throw new AppError(404, 'Application not found');

    if (req.user!.role !== 'HQ_ADMIN' && app.listing.campusId !== req.user!.campusId) {
      throw new AppError(403, 'Cross-campus access denied');
    }

    const updated = await prisma.housingApplication.update({
      where: { id: req.params.id },
      data: { status, notes, reviewedBy: req.user!.userId, reviewedAt: new Date() },
    });

    // If approved, increment occupied count
    if (status === 'APPROVED') {
      await prisma.housingListing.update({
        where: { id: app.listingId },
        data: { occupied: { increment: 1 } },
      });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;

// ─── Aliases for frontend ─────────────────────
// GET /api/housing → same as /listings
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  const campusId = req.user!.role === 'HQ_ADMIN'
    ? (req.query.campusId as string | undefined)
    : req.user!.campusId;
  try {
    const listings = await prisma.housingListing.findMany({
      where: { ...(campusId ? { campusId } : {}), isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(listings);
  } catch (err) { next(err); }
});

// POST /api/housing → create listing
router.post('/', authenticate, requireRole('HQ_ADMIN', 'CAMPUS_LEADER'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = req.body;
    const listing = await prisma.housingListing.create({
      data: { id: uuid(), ...data },
    });
    res.status(201).json(listing);
  } catch (err) { next(err); }
});

// POST /api/housing/:id/apply
router.post('/:id/apply', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.housingApplication.findFirst({
      where: { listingId: req.params.id, userId: req.user!.userId },
    });
    if (existing) throw new AppError(409, 'You have already applied to this listing');

    const application = await prisma.housingApplication.create({
      data: { id: uuid(), listingId: req.params.id, userId: req.user!.userId, status: 'PENDING', notes: req.body.notes },
    });
    res.status(201).json(application);
  } catch (err) { next(err); }
});

// GET /api/housing/my-applications
router.get('/my-applications', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apps = await prisma.housingApplication.findMany({
      where: { userId: req.user!.userId },
      include: { listing: { select: { id: true, partnerName: true, city: true, state: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(apps);
  } catch (err) { next(err); }
});
