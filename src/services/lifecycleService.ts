import { prisma } from '../lib/prisma';
import { logEvent, triggerAlert } from './eventService';
import { broadcastToHQ, broadcastToCampus } from '../lib/websocket';
import { sendEmail, riskAlertTemplate, weeklyDigestTemplate } from '../lib/email';
import { lifecycleLogger } from '../lib/logger';

// ─── Lifecycle Stage Thresholds ───────────────
// PLANNING → LAUNCHING: campus created with leader assigned
// LAUNCHING → ACTIVE: 3+ active members, 2+ meetings held
// ACTIVE → SUSTAINABLE: sustainabilityScore >= 70, 10+ members, 30+ days attendance
// SUSTAINABLE → MULTIPLYING: sustainabilityScore >= 85, 20+ members, ambassador role filled

export const LIFECYCLE_THRESHOLDS = {
  LAUNCHING: { minMembers: 3, minMeetingsHeld: 2 },
  ACTIVE: { minMembers: 10, minSustainabilityScore: 70, minAttendance30d: 30 },
  SUSTAINABLE: { minMembers: 20, minSustainabilityScore: 85, hasAmbassador: true },
  MULTIPLYING: { minMembers: 30, minSustainabilityScore: 90 },
};

// ─── Feature unlock matrix ────────────────────
export const LIFECYCLE_UNLOCKS: Record<string, string[]> = {
  PLANNING:     [],
  LAUNCHING:    ['meetings', 'check_in'],
  ACTIVE:       ['meetings', 'check_in', 'housing', 'workforce', 'testimonies'],
  SUSTAINABLE:  ['meetings', 'check_in', 'housing', 'workforce', 'testimonies', 'donation_pool', 'ambassador'],
  MULTIPLYING:  ['meetings', 'check_in', 'housing', 'workforce', 'testimonies', 'donation_pool', 'ambassador', 'campus_launch'],
};

export function isCampusFeatureUnlocked(lifecycleStage: string, feature: string): boolean {
  return LIFECYCLE_UNLOCKS[lifecycleStage]?.includes(feature) ?? false;
}

// ─── Check and apply lifecycle transitions ────
export async function evaluateCampusLifecycle(campusId: string): Promise<{
  previous: string;
  current: string;
  transitioned: boolean;
  blockers: string[];
}> {
  const campus = await prisma.campus.findUnique({
    where: { id: campusId },
    include: {
      _count: { select: { users: true, meetings: true } },
      sustainabilityIndex: { orderBy: { calculatedAt: 'desc' }, take: 1 },
      users: { where: { role: 'AMBASSADOR' }, take: 1 },
    },
  });

  if (!campus) throw new Error(`Campus ${campusId} not found`);

  const previousStage = campus.lifecycleStage;
  const sustainScore = campus.sustainabilityIndex[0]?.overallScore || 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const attendance30d = await prisma.attendance.count({
    where: { meeting: { campusId }, attendedAt: { gte: thirtyDaysAgo } },
  });
  const memberCount = campus._count.users;
  const blockers: string[] = [];
  let nextStage = previousStage;

  if (previousStage === 'PLANNING') {
    if (memberCount >= LIFECYCLE_THRESHOLDS.LAUNCHING.minMembers && campus._count.meetings >= LIFECYCLE_THRESHOLDS.LAUNCHING.minMeetingsHeld) {
      nextStage = 'LAUNCHING';
    } else {
      if (memberCount < LIFECYCLE_THRESHOLDS.LAUNCHING.minMembers) blockers.push(`Need ${LIFECYCLE_THRESHOLDS.LAUNCHING.minMembers} members (have ${memberCount})`);
      if (campus._count.meetings < LIFECYCLE_THRESHOLDS.LAUNCHING.minMeetingsHeld) blockers.push(`Need ${LIFECYCLE_THRESHOLDS.LAUNCHING.minMeetingsHeld} meetings held`);
    }
  } else if (previousStage === 'LAUNCHING') {
    if (memberCount >= LIFECYCLE_THRESHOLDS.ACTIVE.minMembers && sustainScore >= LIFECYCLE_THRESHOLDS.ACTIVE.minSustainabilityScore && attendance30d >= LIFECYCLE_THRESHOLDS.ACTIVE.minAttendance30d) {
      nextStage = 'ACTIVE';
    } else {
      if (memberCount < LIFECYCLE_THRESHOLDS.ACTIVE.minMembers) blockers.push(`Need ${LIFECYCLE_THRESHOLDS.ACTIVE.minMembers} members (have ${memberCount})`);
      if (sustainScore < LIFECYCLE_THRESHOLDS.ACTIVE.minSustainabilityScore) blockers.push(`Need sustainability score ≥ ${LIFECYCLE_THRESHOLDS.ACTIVE.minSustainabilityScore} (have ${sustainScore.toFixed(0)})`);
      if (attendance30d < LIFECYCLE_THRESHOLDS.ACTIVE.minAttendance30d) blockers.push(`Need ${LIFECYCLE_THRESHOLDS.ACTIVE.minAttendance30d} attendance records in 30 days (have ${attendance30d})`);
    }
  } else if (previousStage === 'ACTIVE') {
    const hasAmbassador = campus.users.length > 0;
    if (memberCount >= LIFECYCLE_THRESHOLDS.SUSTAINABLE.minMembers && sustainScore >= LIFECYCLE_THRESHOLDS.SUSTAINABLE.minSustainabilityScore && hasAmbassador) {
      nextStage = 'SUSTAINABLE';
    } else {
      if (memberCount < LIFECYCLE_THRESHOLDS.SUSTAINABLE.minMembers) blockers.push(`Need ${LIFECYCLE_THRESHOLDS.SUSTAINABLE.minMembers} members (have ${memberCount})`);
      if (sustainScore < LIFECYCLE_THRESHOLDS.SUSTAINABLE.minSustainabilityScore) blockers.push(`Need sustainability score ≥ ${LIFECYCLE_THRESHOLDS.SUSTAINABLE.minSustainabilityScore} (have ${sustainScore.toFixed(0)})`);
      if (!hasAmbassador) blockers.push('Need an Ambassador role filled');
    }
  } else if (previousStage === 'SUSTAINABLE') {
    if (memberCount >= LIFECYCLE_THRESHOLDS.MULTIPLYING.minMembers && sustainScore >= LIFECYCLE_THRESHOLDS.MULTIPLYING.minSustainabilityScore) {
      nextStage = 'MULTIPLYING';
    } else {
      if (memberCount < LIFECYCLE_THRESHOLDS.MULTIPLYING.minMembers) blockers.push(`Need ${LIFECYCLE_THRESHOLDS.MULTIPLYING.minMembers} members (have ${memberCount})`);
      if (sustainScore < LIFECYCLE_THRESHOLDS.MULTIPLYING.minSustainabilityScore) blockers.push(`Need sustainability score ≥ ${LIFECYCLE_THRESHOLDS.MULTIPLYING.minSustainabilityScore} (have ${sustainScore.toFixed(0)})`);
    }
  }

  const transitioned = nextStage !== previousStage;

  if (transitioned) {
    await prisma.campus.update({
      where: { id: campusId },
      data: { lifecycleStage: nextStage as any },
    });

    await logEvent({
      campusId,
      eventType: 'CAMPUS_LIFECYCLE_CHANGED' as any,
      metadata: { from: previousStage, to: nextStage, memberCount, sustainScore },
    });

    broadcastToHQ({ type: 'campus_lifecycle', payload: { campusId, campusName: campus.name, from: previousStage, to: nextStage } });

    lifecycleLogger.info({ campusId, from: previousStage, to: nextStage }, 'Campus lifecycle advanced');
  }

  return { previous: previousStage, current: nextStage, transitioned, blockers };
}

// ─── Risk alert dispatch ──────────────────────
export async function dispatchRiskAlerts(campusId: string): Promise<number> {
  const highRiskUsers = await prisma.scoringHistory.findMany({
    where: {
      user: { campusId },
      relapseRiskLevel: 'HIGH',
      recordedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    include: {
      user: { select: { id: true, name: true, campusId: true } },
    },
  });

  if (highRiskUsers.length === 0) return 0;

  // Find campus leaders to notify
  const leaders = await prisma.user.findMany({
    where: { campusId, role: { in: ['CAMPUS_LEADER', 'HQ_ADMIN'] }, status: 'ACTIVE' },
    select: { id: true, name: true, email: true },
  });

  let dispatched = 0;
  for (const riskEntry of highRiskUsers) {
    for (const leader of leaders) {
      const signals = (riskEntry.signals as string[]) || ['Low attendance', 'Missed check-ins'];
      await sendEmail({
        to: leader.email,
        subject: `⚠️ Risk Alert: ${riskEntry.user.name}`,
        html: riskAlertTemplate(leader.name, riskEntry.user.name, riskEntry.relapseRiskLevel, signals),
      });
      dispatched++;
    }
  }

  return dispatched;
}

// ─── Weekly digest to campus leaders ─────────
export async function sendWeeklyDigests(): Promise<void> {
  const campuses = await prisma.campus.findMany({
    where: { lifecycleStage: { in: ['ACTIVE', 'SUSTAINABLE', 'MULTIPLYING'] } },
    include: { users: { where: { role: 'CAMPUS_LEADER', status: 'ACTIVE' }, select: { id: true, name: true, email: true } } },
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  for (const campus of campuses) {
    if (campus.users.length === 0) continue;

    const [memberCount, attendance7d, donations7d] = await Promise.all([
      prisma.user.count({ where: { campusId: campus.id, status: 'ACTIVE' } }),
      prisma.attendance.count({ where: { meeting: { campusId: campus.id }, attendedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
      prisma.donation.aggregate({ where: { campusId: campus.id, status: 'CONFIRMED', createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }, _sum: { amount: true } }),
    ]);

    const stats = {
      'Active Members': memberCount,
      'Attendance (7d)': attendance7d,
      'Donations (7d)': `$${Number(donations7d._sum.amount || 0).toFixed(0)}`,
    };

    for (const leader of campus.users) {
      await sendEmail({
        to: leader.email,
        subject: `📊 Weekly Digest — ${campus.name}`,
        html: weeklyDigestTemplate(leader.name, campus.name, stats),
      });
    }
  }
}
