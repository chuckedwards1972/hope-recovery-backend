import { EventType } from '@prisma/client';
import { prisma } from '../lib/prisma';

// ─── Full score computation and persistence ───
export async function computeAndPersistScores(userId: string, triggeredBy?: string): Promise<{
  engagement: number;
  relapseRisk: { score: number; level: string; signals: string[] };
  leadership: { ready: boolean; score: number; gaps: string[] };
  certProgress: number;
}> {
  const [engagement, relapseRisk, leadership, certProgress] = await Promise.all([
    computeEngagementScore(userId),
    computeRelapseRisk(userId),
    computeLeadershipReadiness(userId),
    computeCertProgress(userId),
  ]);

  // Persist to scoring history for trend analysis
  await prisma.scoringHistory.create({
    data: {
      userId,
      engagementScore: engagement,
      relapseRisk: relapseRisk.score,
      relapseLevel: relapseRisk.level,
      leadershipScore: leadership.score,
      leadershipReady: leadership.ready,
      certProgress,
      triggeredBy,
    },
  }).catch(() => {}); // non-blocking

  return { engagement, relapseRisk, leadership };
}

// ─── Engagement Score ─────────────────────────
export async function computeEngagementScore(userId: string): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const events = await prisma.platformEvent.findMany({
    where: { userId, createdAt: { gte: thirtyDaysAgo } },
    select: { eventType: true },
  });

  const weights: Partial<Record<EventType, number>> = {
    MEETING_ATTEND: 15,
    LESSON_COMPLETE: 10,
    TESTIMONY_SUBMIT: 12,
    DONATION_MADE: 8,
    JOB_APPLY: 5,
    HOUSING_APPLY: 5,
    LOGIN: 2,
    CERTIFICATION_EARNED: 20,
    LEVEL_UP: 25,
    MEETING_PREP_SUBMIT: 8,
  };

  let score = 0;
  for (const event of events) {
    score += weights[event.eventType as EventType] || 1;
  }

  return Math.min(100, Math.round(score));
}

// ─── Relapse Risk ─────────────────────────────
export async function computeRelapseRisk(userId: string): Promise<{
  score: number;
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  signals: string[];
}> {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const [recentAttendances, recentLogins, recentEvents, missedMeetings] = await Promise.all([
    prisma.attendance.count({
      where: { userId, checkinTime: { gte: fourteenDaysAgo } },
    }),
    prisma.platformEvent.count({
      where: { userId, eventType: 'LOGIN', createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.platformEvent.count({
      where: { userId, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.platformEvent.count({
      where: { userId, eventType: 'LOGIN', createdAt: { gte: threeDaysAgo } },
    }),
  ]);

  const signals: string[] = [];
  let riskScore = 0;

  if (recentAttendances === 0) { signals.push('No meeting attendance in 14 days'); riskScore += 40; }
  else if (recentAttendances === 1) { signals.push('Only 1 meeting in 14 days — below normal'); riskScore += 15; }

  if (recentLogins === 0) { signals.push('No platform login in 7 days'); riskScore += 25; }
  if (missedMeetings === 0) { signals.push('No activity in last 3 days'); riskScore += 10; }
  if (recentEvents < 3) { signals.push('Minimal platform engagement this week'); riskScore += 15; }

  const level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
    riskScore >= 65 ? 'CRITICAL' :
    riskScore >= 40 ? 'HIGH' :
    riskScore >= 20 ? 'MEDIUM' : 'LOW';

  return { score: Math.min(100, riskScore), level, signals };
}

// ─── Leadership Readiness ────────────────────
export async function computeLeadershipReadiness(userId: string): Promise<{
  ready: boolean;
  score: number;
  gaps: string[];
}> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [attendances, certifications, user] = await Promise.all([
    prisma.attendance.count({ where: { userId, checkinTime: { gte: ninetyDaysAgo } } }),
    prisma.certification.count({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { level: true, sobrietyDate: true } }),
  ]);

  const gaps: string[] = [];
  let score = 0;

  if (attendances >= 20) score += 30;
  else gaps.push(`Attend ${20 - attendances} more meetings in the next 90 days`);

  if (certifications >= 2) score += 25;
  else gaps.push(`Complete ${2 - certifications} more certification(s)`);

  if (user?.sobrietyDate) {
    const sobrietyDays = Math.floor(
      (Date.now() - new Date(user.sobrietyDate).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (sobrietyDays >= 180) score += 45;
    else gaps.push(`${180 - sobrietyDays} more days of sobriety needed`);
  } else {
    gaps.push('Set your sobriety date in your profile');
  }

  return { ready: score >= 80, score, gaps };
}

// ─── Certification Progress ──────────────────
export async function computeCertProgress(userId: string): Promise<number> {
  const TARGET_CERTS = 5;
  const count = await prisma.certification.count({ where: { userId } });
  return Math.min(100, Math.round((count / TARGET_CERTS) * 100));
}

// ─── Campus Sustainability Index ─────────────
export async function computeSustainabilityIndex(campusId: string): Promise<{
  total: number;
  components: Record<string, number>;
  recommendedLifecycle: string;
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  const [
    memberCount,
    attendanceCurrent,
    attendancePrevious,
    donorCount,
    totalDonations,
    housingData,
    workforceData,
    leaders,
  ] = await Promise.all([
    prisma.user.count({ where: { campusId, status: 'ACTIVE' } }),
    prisma.attendance.count({ where: { meeting: { campusId }, checkinTime: { gte: thirtyDaysAgo } } }),
    prisma.attendance.count({ where: { meeting: { campusId }, checkinTime: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } } }),
    prisma.donation.groupBy({ by: ['userId'], where: { campusId, verificationStatus: 'VERIFIED' } }),
    prisma.donation.aggregate({ where: { campusId, verificationStatus: 'VERIFIED' }, _sum: { amount: true } }),
    prisma.housingListing.aggregate({ where: { campusId }, _sum: { capacity: true, occupied: true } }),
    prisma.jobApplication.count({ where: { job: { campusId }, status: 'APPROVED' } }),
    prisma.user.count({ where: { campusId, role: { in: ['CAMPUS_LEADER', 'GROUP_CHAIR', 'AMBASSADOR'] } } }),
  ]);

  // Attendance score (0-25): growth trend
  const attendanceTrend = attendancePrevious > 0
    ? ((attendanceCurrent - attendancePrevious) / attendancePrevious) * 100
    : 0;
  const attendanceScore = Math.min(25, Math.max(0,
    attendanceCurrent >= 20 ? 20 + Math.min(5, attendanceTrend / 10) : Math.round(attendanceCurrent / 20 * 20)
  ));

  // Donor score (0-25): active donors + total raised
  const donorScore = Math.min(25,
    Math.round((donorCount.length / 10) * 15 + (Math.min(5000, Number(totalDonations._sum.amount || 0)) / 5000) * 10)
  );

  // Housing score (0-20): occupancy rate
  const cap = housingData._sum.capacity || 0;
  const occ = housingData._sum.occupied || 0;
  const housingScore = cap > 0 ? Math.min(20, Math.round((occ / cap) * 20)) : 0;

  // Workforce score (0-15): successful placements
  const workforceScore = Math.min(15, Math.round(workforceData / 2));

  // Leadership score (0-15): depth of leadership pipeline
  const leadershipScore = Math.min(15, Math.round(leaders * 3));

  const total = Math.round(attendanceScore + donorScore + housingScore + workforceScore + leadershipScore);

  const recommendedLifecycle =
    total >= 85 ? 'MULTIPLYING' :
    total >= 65 ? 'SUSTAINABLE' :
    total >= 40 ? 'ACTIVE' :
    total >= 20 ? 'LAUNCHING' : 'PLANNING';

  // Persist to DB
  await prisma.campusSustainabilityIndex.upsert({
    where: { campusId },
    update: { attendanceScore, donorScore, housingScore, workforceScore, leadershipScore, totalScore: total, recommendedLifecycle, computedAt: new Date() },
    create: { id: require('uuid').v4(), campusId, attendanceScore, donorScore, housingScore, workforceScore, leadershipScore, totalScore: total, recommendedLifecycle },
  }).catch(() => {});

  return {
    total,
    components: { attendanceScore, donorScore, housingScore, workforceScore, leadershipScore },
    recommendedLifecycle,
  };
}
