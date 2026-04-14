import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { verifyAccessToken, TokenPayload } from '../lib/jwt';

// Extend Express Request with auth context
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

// ─── Require valid JWT ────────────────────────
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Role gate ───────────────────────────────
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: roles,
        current: req.user.role,
      });
    }
    next();
  };
}

// ─── Campus isolation ─────────────────────────
// Ensures non-HQ_ADMIN users can only access their own campus data
export function requireCampusAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  // HQ Admins can access any campus
  if (req.user.role === 'HQ_ADMIN') {
    return next();
  }

  const requestedCampusId = req.params.campusId || req.query.campusId as string;

  if (requestedCampusId && requestedCampusId !== req.user.campusId) {
    return res.status(403).json({ error: 'Access denied: cross-campus data not permitted' });
  }

  next();
}

// ─── Self or leader ──────────────────────────
// Allows users to access their own data OR leaders to access their campus members
export function requireSelfOrLeader(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  const leaderRoles: Role[] = ['CAMPUS_LEADER', 'AMBASSADOR', 'HQ_ADMIN'];
  const isSelf = req.params.userId === req.user.userId;
  const isLeader = leaderRoles.includes(req.user.role);

  if (isSelf || isLeader) {
    return next();
  }

  return res.status(403).json({ error: 'Access denied' });
}

// Role level helpers
export const ROLE_LEVELS: Record<Role, number> = {
  HQ_ADMIN: 0,
  AMBASSADOR: 1,
  CAMPUS_LEADER: 2,
  GROUP_CHAIR: 3,
  MEMBER: 4,
};

export function hasMinimumRole(userRole: Role, minimumRole: Role): boolean {
  return ROLE_LEVELS[userRole] <= ROLE_LEVELS[minimumRole];
}
