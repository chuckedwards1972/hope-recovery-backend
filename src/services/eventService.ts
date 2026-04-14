import { prisma } from '../lib/prisma';
import { broadcastToCampus } from '../lib/websocket';

// Re-export all scoring functions from dedicated scoring service
export {
  computeEngagementScore,
  computeRelapseRisk,
  computeLeadershipReadiness,
  computeAndPersistScores,
  computeSustainabilityIndex,
} from './scoringService';

interface LogEventOptions {
  userId: string;
  campusId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// Core event logger — non-blocking, never throws
export async function logEvent(opts: LogEventOptions): Promise<void> {
  try {
    await prisma.platformEvent.create({
      data: {
        userId: opts.userId,
        campusId: opts.campusId,
        eventType: opts.eventType as any,
        metadata: opts.metadata || {},
        ipAddress: opts.ipAddress,
        userAgent: opts.userAgent,
      },
    });
  } catch (err) {
    console.error('[EventLog] Failed:', err);
  }
}

// Alert trigger — WebSocket broadcast to campus leaders
export async function triggerAlert(opts: {
  campusId: string;
  memberId: string;
  memberName: string;
  type: 'relapse-risk' | 'missed-meetings' | 'payment-overdue';
  severity: 'warning' | 'critical';
  note: string;
}) {
  broadcastToCampus(opts.campusId, {
    type: 'ALERT_TRIGGERED',
    campusId: opts.campusId,
    payload: opts,
  });
}
