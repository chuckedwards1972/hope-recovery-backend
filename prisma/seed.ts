import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding POLR Platform v5...');

  // ─── Campuses ────────────────────────────────
  const campusDefs = [
    { slug: 'polr-thibodaux', name: 'POLR Place — Thibodaux', city: 'Thibodaux', state: 'LA', address: '501-A St. Mary St, Thibodaux, LA 70301', phone: '985.224.7421', email: 'admin@polris4life.com', lifecycleStage: 'SUSTAINABLE' as const, zeffyLink: 'https://www.zeffy.com/en-US/donation-form/polr-core', isSharedPool: true },
    { slug: 'hop-thibodaux',  name: 'HOP — Thibodaux',        city: 'Thibodaux', state: 'LA', address: '2229 Hwy 3185, Thibodaux, LA', lifecycleStage: 'ACTIVE' as const, zeffyLink: 'https://www.zeffy.com/en-US/donation-form/polr-core', isSharedPool: true },
    { slug: 'hop-larose',     name: 'HOP — Larose',            city: 'Larose',    state: 'LA', lifecycleStage: 'ACTIVE' as const, zeffyLink: 'https://www.zeffy.com/en-US/donation-form/polr-core', isSharedPool: true },
    { slug: 'polr-port-allen',name: 'POLR @ Port Allen',       city: 'Port Allen',state: 'LA', address: '12883 Hwy 190 W, Port Allen, LA 70767', lifecycleStage: 'LAUNCHING' as const, zeffyLink: 'https://www.zeffy.com/en-US/donation-form/polr-port-allen', isSharedPool: false },
  ];

  const campusIds: Record<string, string> = {};
  for (const def of campusDefs) {
    const c = await prisma.campus.upsert({
      where: { slug: def.slug },
      update: {},
      create: { id: uuid(), ...def },
    });
    campusIds[def.slug] = c.id;
    console.log(`  ✓ Campus: ${def.name}`);
  }

  const hqId = campusIds['polr-thibodaux'];

  // ─── Donation Pools ──────────────────────────
  const corePool = await prisma.donationPool.upsert({
    where: { id: 'polr-core-pool' },
    update: {},
    create: { id: 'polr-core-pool', name: 'POLR Core Ministry Fund', zeffyLink: 'https://www.zeffy.com/en-US/donation-form/polr-core', targetAmount: 5000, currentBalance: 0, isActive: true },
  });
  const paPool = await prisma.donationPool.upsert({
    where: { id: 'polr-port-allen-pool' },
    update: {},
    create: { id: 'polr-port-allen-pool', name: 'Port Allen Campus Fund', zeffyLink: 'https://www.zeffy.com/en-US/donation-form/polr-port-allen', targetAmount: 2000, currentBalance: 0, isActive: true },
  });

  await prisma.campus.update({ where: { id: hqId }, data: { donationPoolId: corePool.id } });
  await prisma.campus.update({ where: { id: campusIds['polr-port-allen'] }, data: { donationPoolId: paPool.id, isSharedPool: false } });
  console.log(`  ✓ Donation pools wired`);

  // ─── Users ───────────────────────────────────
  const adminHash   = await bcrypt.hash('ACTS2:38', 12);
  const leaderHash  = await bcrypt.hash('POLRleader2024!', 12);
  const memberHash  = await bcrypt.hash('WalkWell2024!', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@polris4life.com' },
    update: {},
    create: { id: uuid(), name: 'POLRHQ', email: 'admin@polris4life.com', passwordHash: adminHash, role: 'HQ_ADMIN', level: 0, campusId: hqId, sobrietyDate: new Date('1995-07-05'), bio: "Founder of POLR. 30 years of sobriety by God's grace.", status: 'ACTIVE' },
  });
  console.log(`  ✓ HQ Admin: ${admin.email}`);

  for (const [slug, name, email] of [
    ['hop-thibodaux',   'Thibodaux HOP Leader', 'leader.thib@polris4life.com'],
    ['hop-larose',      'Larose HOP Leader',    'leader.larose@polris4life.com'],
    ['polr-port-allen', 'Port Allen Leader',    'leader.portallen@polris4life.com'],
  ] as [string, string, string][]) {
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: { id: uuid(), name, email, passwordHash: leaderHash, role: 'CAMPUS_LEADER', level: 2, campusId: campusIds[slug], status: 'ACTIVE' },
    });
    console.log(`  ✓ Leader: ${name}`);
  }

  await prisma.user.upsert({
    where: { email: 'demo.member@polris4life.com' },
    update: {},
    create: { id: uuid(), name: 'Demo Member', email: 'demo.member@polris4life.com', passwordHash: memberHash, role: 'MEMBER', level: 5, campusId: hqId, sobrietyDate: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), status: 'ACTIVE' },
  });
  console.log(`  ✓ Demo Member: demo.member@polris4life.com`);

  // ─── Meetings ────────────────────────────────
  const now = new Date();
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));

  const meetingDefs = [
    { campusId: hqId,                              title: 'POLR Place Daily',          topic: 'Daily Recovery', location: '501-A St. Mary St, Thibodaux', dayOfWeek: 'Monday',    timeOfDay: '7:00 AM', isRecurring: true },
    { campusId: hqId,                              title: 'POLR Place Daily',          topic: 'Daily Recovery', location: '501-A St. Mary St, Thibodaux', dayOfWeek: 'Tuesday',   timeOfDay: '7:00 AM', isRecurring: true },
    { campusId: hqId,                              title: 'POLR Place Daily',          topic: 'Daily Recovery', location: '501-A St. Mary St, Thibodaux', dayOfWeek: 'Wednesday', timeOfDay: '7:00 AM', isRecurring: true },
    { campusId: hqId,                              title: 'POLR Place Daily',          topic: 'Daily Recovery', location: '501-A St. Mary St, Thibodaux', dayOfWeek: 'Thursday',  timeOfDay: '7:00 AM', isRecurring: true },
    { campusId: hqId,                              title: 'POLR Place Daily',          topic: 'Daily Recovery', location: '501-A St. Mary St, Thibodaux', dayOfWeek: 'Friday',    timeOfDay: '7:00 AM', isRecurring: true },
    { campusId: hqId,                              title: 'POLR Place Daily',          topic: 'Daily Recovery', location: '501-A St. Mary St, Thibodaux', dayOfWeek: 'Saturday',  timeOfDay: '7:00 AM', isRecurring: true },
    { campusId: campusIds['hop-thibodaux'],         title: 'HOP Wednesday Night',       topic: 'Step Work',      location: '2229 Hwy 3185, Thibodaux',      dayOfWeek: 'Wednesday', timeOfDay: '7:00 PM', isRecurring: true },
    { campusId: campusIds['hop-larose'],            title: 'HOP Larose Wednesday',      topic: 'Step Work',      location: 'Larose, LA',                    dayOfWeek: 'Wednesday', timeOfDay: '7:00 PM', isRecurring: true },
    { campusId: campusIds['polr-port-allen'],       title: 'POLR Port Allen Monday',    topic: 'Recovery',       location: '12883 Hwy 190 W, Port Allen',   dayOfWeek: 'Monday',    timeOfDay: '6:00 PM', isRecurring: true },
    { campusId: campusIds['polr-port-allen'],       title: 'POLR Port Allen Friday',    topic: 'Recovery',       location: '12883 Hwy 190 W, Port Allen',   dayOfWeek: 'Friday',    timeOfDay: '6:00 PM', isRecurring: true },
  ];

  for (const m of meetingDefs) {
    await prisma.meeting.create({ data: { id: uuid(), meetingDate: nextMonday, ...m } });
  }
  console.log(`  ✓ ${meetingDefs.length} meetings seeded`);

  // ─── Housing Listing ─────────────────────────
  await prisma.housingListing.create({
    data: { id: uuid(), campusId: hqId, partnerName: 'POLR House — Thibodaux', city: 'Thibodaux', state: 'LA', housingType: 'SOBER_LIVING', capacity: 8, occupied: 0, monthlyRent: 450, requiresSobriety: true, description: 'Christ-centered sober living. Structured environment with meeting requirements, curfew, and house responsibilities.', contactEmail: 'admin@polris4life.com', contactPhone: '985.224.7421' },
  });
  console.log(`  ✓ POLR House listing`);

  // ─── Sustainability Index ─────────────────────
  await prisma.campusSustainabilityIndex.upsert({
    where: { campusId: hqId },
    update: {},
    create: { campusId: hqId, overallScore: 78.5, attendanceScore: 82, financialScore: 71, leadershipScore: 85, engagementScore: 76, calculatedAt: new Date() },
  });
  console.log(`  ✓ Sustainability index set`);

  console.log('');
  console.log('✅ Seed complete!');
  console.log('');
  console.log('Credentials:');
  console.log('  HQ Admin:    username: POLRHQ  /  password: ACTS2:38');
  console.log('               email:    admin@polris4life.com');
  console.log('  Leader:      leader.thib@polris4life.com  /  POLRleader2024!');
  console.log('  Member:      demo.member@polris4life.com  /  WalkWell2024!');
  console.log('');
  console.log('"Walk well."');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
