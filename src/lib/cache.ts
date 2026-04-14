import Redis from 'ioredis';
import { logger } from './logger';

// ─── Redis singleton ──────────────────────────
let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;

  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    redis.on('connect', () => logger.info('Redis connected'));
    redis.on('error', (err) => {
      logger.warn({ err: err.message }, 'Redis error — cache disabled');
      redis = null;
    });
  }

  return redis;
}

// ─── TTL constants (seconds) ─────────────────
export const TTL = {
  SCORE: 60 * 15,        // 15 min — scoring results
  CAMPUS_STATS: 60 * 5,  // 5 min — campus metrics
  SUSTAINABILITY: 60 * 60, // 1 hr — sustainability index
  USER_PROFILE: 60 * 10, // 10 min — user profile
  MEDIA_LIST: 60 * 2,    // 2 min — media feed
} as const;

// ─── Cache helpers ────────────────────────────

export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // non-blocking
  }
}

export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    // non-blocking
  }
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const keys = await r.keys(pattern);
    if (keys.length > 0) await r.del(...keys);
  } catch {
    // non-blocking
  }
}

// ─── Cache key builders ───────────────────────
export const CacheKey = {
  userScore: (userId: string) => `score:user:${userId}`,
  campusStats: (campusId: string) => `stats:campus:${campusId}`,
  sustainability: (campusId: string) => `sustain:${campusId}`,
  userProfile: (userId: string) => `profile:${userId}`,
  mediaList: (campusId?: string) => `media:list:${campusId || 'global'}`,
  hqStats: () => 'stats:hq',
};

// ─── Cache-aside wrapper ──────────────────────
// Usage: const data = await cached(CacheKey.userScore(id), TTL.SCORE, () => expensiveQuery())
export async function cached<T>(
  key: string,
  ttl: number,
  fn: () => Promise<T>
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const result = await fn();
  await cacheSet(key, result, ttl);
  return result;
}
