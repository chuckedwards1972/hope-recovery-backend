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

// RRN PWA login - accepts username or email + password
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password } = req.body as any;
    const identifier = (username || email || '').trim();
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { email: { startsWith: identifier + '@' } },
          { email: { startsWith: identifier.toLowerCase() + '@' } },
        ]
      }
    });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, (user as any).passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signAccessToken({ userId: user.id, role: (user as any).role || 'member' });
    const refreshToken = signRefreshToken({ userId: user.id });
    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        username: identifier,
        name: (user as any).name || user.email,
        role: (user as any).role || 'member',
        level: (user as any).level || 0,
        campus: (user as any).campus || 'All',
      }
    });
  } catch (e) { next(e); }
});

// --- Schemas ---
const LoginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.string().optional(),
  campusId: z.string().optional(),
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, (user as any).passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signAccessToken({ userId: user.id, role: (user as any).role || 'member' });
    const refreshToken = signRefreshToken({ userId: user.id });
    await logEvent('auth.login', user.id, { email });
    res.json({ token, refreshToken, user: { id: user.id, email: user.email, name: (user as any).name, role: (user as any).role } });
  } catch (e) { next(e); }
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = RegisterSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: { id: uuid(), email: data.email, name: data.name, passwordHash, role: data.role || 'member' } as any
    });
    const token = signAccessToken({ userId: user.id, role: (user as any).role });
    const refreshToken = signRefreshToken({ userId: user.id });
    res.status(201).json({ token, refreshToken, user: { id: user.id, email: user.email } });
  } catch (e) { next(e); }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
    const payload = verifyRefreshToken(refreshToken) as any;
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) return res.status(401).json({ error: 'User not found' });
    const token = signAccessToken({ userId: user.id, role: (user as any).role || 'member' });
    const newRefresh = signRefreshToken({ userId: user.id });
    res.json({ token, refreshToken: newRefresh });
  } catch (e) { next(e); }
});

// GET /api/auth/profile
router.get('/profile', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) { next(e); }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export default router;
