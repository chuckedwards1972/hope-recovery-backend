/**
 * RRN Curriculum Seed Script
 * Pushes all 52 lessons to the Railway database via the /api/lms/seed endpoint
 * Run: node seed-curriculum.js
 */
'use strict';

const https = require('https');
const http  = require('http');

// ── CONFIG ────────────────────────────────────────────────────
const API_BASE = process.env.API_BASE ||
  'https://hope-recovery-backend-production.up.railway.app/api';
const ADMIN_USER = process.env.ADMIN_USER || 'RRNHQ';
const ADMIN_PASS = process.env.ADMIN_PASS || 'ACTS2:38';

// ── CURRICULUM DATA ───────────────────────────────────────────
// Load from the LMS data file built by the curriculum builder
const lmsData = require('./rrn_lms_data.json');

// ── HTTP HELPER ───────────────────────────────────────────────
function apiCall(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('[SEED] Refined Recovery Network — Curriculum Seed');
  console.log(`[SEED] Target: ${API_BASE}`);
  console.log(`[SEED] Courses: ${lmsData.courses.length}, Lessons: ${lmsData.lessons.length}`);

  // 1. Login as L0 admin
  console.log('\n[SEED] Authenticating...');
  const authRes = await apiCall('POST', '/auth', {
    username: ADMIN_USER,
    password: ADMIN_PASS,
  });

  if (authRes.status !== 200 || !authRes.body.token) {
    console.error('[SEED] Auth failed:', authRes.status, authRes.body);
    process.exit(1);
  }

  const token = authRes.body.token;
  console.log('[SEED] Authenticated as', authRes.body.session?.name);

  // 2. Run schema (optional - remind user)
  console.log('\n[SEED] Note: Make sure schema.sql has been applied to your Railway database');
  console.log('[SEED] Run: psql $DATABASE_URL -f schema.sql');

  // 3. Seed curriculum in batches
  console.log('\n[SEED] Seeding curriculum...');

  // Send in batches of 10 lessons to avoid payload limits
  const BATCH_SIZE = 10;
  let totalSeeded = 0;

  // First send all courses
  const courseRes = await apiCall('POST', '/lms/seed', {
    courses: lmsData.courses,
    lessons: [],
  }, token);

  if (courseRes.status !== 200) {
    console.error('[SEED] Course seed failed:', courseRes.status, courseRes.body);
  } else {
    console.log(`[SEED] Courses seeded: ${courseRes.body.courseCount}`);
  }

  // Then seed lessons in batches
  for (let i = 0; i < lmsData.lessons.length; i += BATCH_SIZE) {
    const batch = lmsData.lessons.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(lmsData.lessons.length / BATCH_SIZE);

    process.stdout.write(`[SEED] Batch ${batchNum}/${totalBatches} (lessons ${i+1}-${Math.min(i+BATCH_SIZE, lmsData.lessons.length)})... `);

    const res = await apiCall('POST', '/lms/seed', {
      courses: [],
      lessons: batch,
    }, token);

    if (res.status !== 200) {
      console.error('FAILED:', res.status, JSON.stringify(res.body).slice(0, 100));
    } else {
      totalSeeded += res.body.lessonCount || 0;
      console.log(`OK (${res.body.lessonCount} lessons)`);
    }

    // Small delay between batches
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n[SEED] Complete! ${totalSeeded} lessons seeded to database.`);
  console.log('[SEED] Verify at:', API_BASE + '/lms/lessons');
}

main().catch(err => {
  console.error('[SEED] Fatal error:', err.message);
  process.exit(1);
});
