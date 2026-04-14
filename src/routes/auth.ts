import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { prisma } from '../lib/prisma';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logEvent } from '../services/eventService';

const router = Router();

// ─── Schemas ─────────────────────────────────
const LoginSchema = z.object({
  // Accept either email or username in the same field
  email: z.string().min(1),
  password: z.string().min(1),
});

const RegisterSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  campusId: z.string().uuid(),
  agreedToTerms: z.boolean().refine((v) => v === true, 'Must accept terms'),
  agreedToMedical: z.boolean().refine((v) => v === true, 'Must accept medical disclaimer'),
  agreedToConduct: z.boolean().refine((v) => v === true, 'Must accept conduct policy'),
});

// ─── POST /api/auth/register ─────────────────
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = RegisterSchema.parse(req.body);

    // Verify campus exists
    const campus = await prisma.campus.findUnique({ where: { id: data.campusId } });
    if (!campus) throw new AppError(404, 'Campus not found');

    // Check duplicate email
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new AppError(409, 'An account with this email already exists');

    const passwordHash = await bcrypt.hash(data.password, 12);

    const user = await prisma.user.create({
      data: {
        id: uuid(),
        name: data.name,
        email: data.email,
        passwordHash,
        campusId: data.campusId,
        role: 'MEMBER',
        level: 5,
      },
      select: {
        id: true, name: true, email: true, role: true, level: true,
        campusId: true, campus: { select: { name: true, slug: true } },
      },
    });

    const tokenId = uuid();
    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      campusId: user.campusId,
      level: user.level,
    });
    const refreshToken = signRefreshToken({ userId: user.id, tokenId });

    // Store refresh token
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
      data: { id: tokenId, token: refreshToken, userId: user.id, expiresAt },
    });

    await logEvent({
      userId: user.id,
      campusId: user.campusId,
      eventType: 'LOGIN',
      metadata: { action: 'register', campus: campus.name },
      ipAddress: req.ip,
    });

    res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/login ────────────────────
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = LoginSchema.parse(req.body);

    // Support login by username (name field) OR email
    const isEmail = data.email.includes('@');
    const user = isEmail
      ? await prisma.user.findUnique({
          where: { email: data.email },
          include: { campus: { select: { name: true, slug: true, zeffyLink: true } } },
        })
      : await prisma.user.findFirst({
          where: { name: { equals: data.email, mode: 'insensitive' } },
          include: { campus: { select: { name: true, slug: true, zeffyLink: true } } },
        });

    if (!user) throw new AppError(401, 'Invalid username/email or password');
    if (user.status === 'SUSPENDED') throw new AppError(403, 'Account suspended. Contact your campus leader.');
    if (user.status === 'INACTIVE') throw new AppError(403, 'Account inactive. Please contact support.');

    const valid = await bcrypt.compare(data.password, user.passwordHash);
    if (!valid) throw new AppError(401, 'Invalid email or password');

    const tokenId = uuid();
    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      campusId: user.campusId,
      level: user.level,
    });
    const refreshToken = signRefreshToken({ userId: user.id, tokenId });

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await Promise.all([
      prisma.refreshToken.create({
        data: { id: tokenId, token: refreshToken, userId: user.id, expiresAt },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    ]);

    await logEvent({
      userId: user.id,
      campusId: user.campusId,
      eventType: 'LOGIN',
      ipAddress: req.ip,
    });

    const { passwordHash: _, ...safeUser } = user;
    res.json({ user: safeUser, accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/refresh ──────────────────
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError(400, 'Refresh token required');

    const payload = verifyRefreshToken(refreshToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!stored || stored.expiresAt < new Date()) {
      throw new AppError(401, 'Invalid or expired refresh token');
    }

    // Rotate: delete old, issue new
    const newTokenId = uuid();
    const newAccess = signAccessToken({
      userId: stored.user.id,
      email: stored.user.email,
      role: stored.user.role,
      campusId: stored.user.campusId,
      level: stored.user.level,
    });
    const newRefresh = signRefreshToken({ userId: stored.user.id, tokenId: newTokenId });

    await prisma.$transaction([
      prisma.refreshToken.delete({ where: { id: payload.tokenId } }),
      prisma.refreshToken.create({
        data: {
          id: newTokenId,
          token: newRefresh,
          userId: stored.user.id,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);

    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/logout ───────────────────
router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }

    await logEvent({
      userId: req.user!.userId,
      campusId: req.user!.campusId,
      eventType: 'LOGOUT',
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/auth/me ────────────────────────
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true, name: true, email: true, role: true, level: true,
        campusId: true, status: true, phone: true, avatarUrl: true,
        sobrietyDate: true, joinedAt: true, lastLoginAt: true,
        campus: {
          select: { id: true, name: true, slug: true, lifecycleStage: true, zeffyLink: true },
        },
      },
    });

    if (!user) throw new AppError(404, 'User not found');
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/forgot-password ─────────
import crypto from 'crypto';
import { sendEmail, passwordResetTemplate } from '../lib/email';

router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });

    // Always respond 200 to prevent email enumeration
    if (!user) return res.json({ success: true });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: token, passwordResetExpires: expires },
    });

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
    await sendEmail({
      to: email,
      subject: 'Reset your POLR password',
      html: passwordResetTemplate(resetUrl, user.name),
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/reset-password ───────────
router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = z.object({
      token: z.string().min(32),
      password: z.string().min(8),
    }).parse(req.body);

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: token,
        passwordResetExpires: { gt: new Date() },
      },
    });

    if (!user) throw new AppError(400, 'Invalid or expired reset token');

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    // Invalidate all refresh tokens on password reset
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch (err) { next(err); }
});

export default router;
