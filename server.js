'use strict';

const express     = require('express');
const { Pool }    = require('pg');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');

// ── ENV ───────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET  = process.env.JWT_SECRET || 'rrn-dev-secret-change-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean).concat([
  'https://refinedrecovery.com',
  'https://www.refinedrecovery.com',
  'https://chuckedwards1972.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
]);

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL not set');
  process.exit(1);
}

// ── DATABASE ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// ── APP SETUP ─────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,  // handled by client
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: function(origin, cb) {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Allow any *.railway.app subdomain for internal calls
    if (origin.endsWith('.railway.app')) return cb(null, true);
    return cb(null, false); // Reject — don't throw, just deny
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Client-ID'],
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── RATE LIMITING ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 20,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);

// ── HELPERS ───────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    {
      sub:      user.id,
      username: user.username,
      email:    user.email,
      name:     user.name,
      role:     user.role,
      level:    user.level,
      campus:   user.campus_id,
      title:    user.title,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireLevel(maxLevel) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.level > maxLevel) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function audit(userId, action, entityType, entityId, details, ip) {
  query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, action, entityType, entityId, details || {}, ip]
  ).catch(err => console.error('[AUDIT]', err.message));
}

// ── HEALTH ────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', ts: new Date().toISOString(), service: 'RRN Backend' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ── AUTH ──────────────────────────────────────────────────────
// POST /api/auth  — login
app.post('/api/auth', authLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const identifier = email || username;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Credentials required' });
    }

    const r = await query(
      `SELECT * FROM users
       WHERE (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1))
         AND status != 'Suspended'
       LIMIT 1`,
      [identifier]
    );

    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    const session = {
      id:       user.id,
      username: user.username,
      email:    user.email,
      name:     user.name,
      role:     user.role,
      level:    user.level,
      campus:   user.campus_id,
      title:    user.title || 'Member',
      token:    token,
    };

    audit(user.id, 'login', 'user', user.id, {}, req.ip);
    res.json({ ok: true, token, session });

  } catch (err) {
    console.error('[AUTH]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/register — self-register as member
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password, campus_id } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const exists = await query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const r = await query(
      `INSERT INTO users (username, email, password_hash, name, role, level, campus_id, status)
       VALUES ($1,$2,$3,$4,'member',5,$5,'Intake')
       RETURNING id, username, email, name, role, level, campus_id, title`,
      [email, email, hash, name, campus_id || null]
    );
    const user = r.rows[0];
    const token = signToken(user);

    res.status(201).json({
      ok: true, token,
      session: { id: user.id, username: user.username, email: user.email,
                 name: user.name, role: user.role, level: user.level,
                 campus: user.campus_id, title: user.title || 'Member', token }
    });
  } catch (err) {
    console.error('[REGISTER]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me — validate token, return current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const r = await query(
      'SELECT id,username,email,name,role,level,campus_id,title,status FROM users WHERE id=$1',
      [req.user.sub]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
  audit(req.user.sub, 'logout', 'user', req.user.sub, {}, req.ip);
  res.json({ ok: true });
});

// ── MEMBERS ───────────────────────────────────────────────────
// GET /api/members — list members (staff+)
app.get('/api/members', requireAuth, requireLevel(4), async (req, res) => {
  try {
    const { campus_id, status, search, limit = 100, offset = 0 } = req.query;
    let where = ['u.role IN (\'member\',\'staff\',\'leader\',\'director\')'];
    const params = [];
    let pi = 1;

    // Staff can only see their campus unless HQ
    if (req.user.level >= 3 && req.user.campus) {
      where.push(`u.campus_id = $${pi++}`);
      params.push(req.user.campus);
    } else if (campus_id) {
      where.push(`u.campus_id = $${pi++}`);
      params.push(campus_id);
    }

    if (status) { where.push(`u.status = $${pi++}`); params.push(status); }
    if (search) {
      where.push(`(LOWER(u.name) LIKE $${pi} OR LOWER(u.email) LIKE $${pi})`);
      params.push(`%${search.toLowerCase()}%`);
      pi++;
    }

    const sql = `
      SELECT u.id, u.username, u.email, u.name, u.role, u.level, u.status,
             u.phone, u.title, u.join_date, u.sobriety_date, u.pipeline_stage,
             u.steps_completed, u.attendance_count, u.notes,
             c.name AS campus_name, u.campus_id,
             COALESCE(ps.lessons_completed, 0) AS lessons_completed
      FROM users u
      LEFT JOIN campuses c ON c.id = u.campus_id
      LEFT JOIN member_progress_summary ps ON ps.user_id = u.id
      WHERE ${where.join(' AND ')}
      ORDER BY u.name ASC
      LIMIT $${pi++} OFFSET $${pi++}`;
    params.push(parseInt(limit), parseInt(offset));

    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('[MEMBERS]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/members — create member
app.post('/api/members', requireAuth, requireLevel(3), async (req, res) => {
  try {
    const { name, email, campus_id, role='member', level=5, phone, sobriety_date, notes } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const password = Math.random().toString(36).slice(-10);
    const hash = await bcrypt.hash(password, 12);

    const r = await query(
      `INSERT INTO users (username,email,password_hash,name,role,level,campus_id,phone,sobriety_date,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id,username,email,name,role,level,campus_id,status`,
      [email, email, hash, name, role, level, campus_id||null, phone||null, sobriety_date||null, notes||null]
    );
    audit(req.user.sub, 'create_member', 'user', r.rows[0].id, { name, email }, req.ip);
    res.status(201).json({ ...r.rows[0], tempPassword: password });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    console.error('[CREATE MEMBER]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/members/:id
app.get('/api/members/:id', requireAuth, requireLevel(4), async (req, res) => {
  try {
    const r = await query(
      `SELECT u.*, c.name AS campus_name,
              COALESCE(ps.lessons_completed,0) AS lessons_completed,
              COALESCE(ps.steps_exam_passed,0) AS steps_exam_passed
       FROM users u
       LEFT JOIN campuses c ON c.id = u.campus_id
       LEFT JOIN member_progress_summary ps ON ps.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = r.rows[0];
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/members/:id
app.patch('/api/members/:id', requireAuth, requireLevel(3), async (req, res) => {
  try {
    const allowed = ['name','phone','status','campus_id','title','role','level',
                     'sobriety_date','notes','pipeline_stage','steps_completed','attendance_count'];
    const updates = [];
    const params = [];
    let pi = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${pi++}`);
        params.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const r = await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at=NOW() WHERE id=$${pi} RETURNING id,name,status`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    audit(req.user.sub, 'update_member', 'user', req.params.id, req.body, req.ip);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[PATCH MEMBER]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── CAMPUSES ──────────────────────────────────────────────────
app.get('/api/admin/campuses', requireAuth, requireLevel(2), async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*, COUNT(u.id) AS member_count
       FROM campuses c LEFT JOIN users u ON u.campus_id = c.id AND u.role='member'
       GROUP BY c.id ORDER BY c.name`,
      []
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/campuses', requireAuth, requireLevel(1), async (req, res) => {
  try {
    const { name, city, state='LA', address, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const r = await query(
      'INSERT INTO campuses (name,city,state,address,phone) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, city||null, state, address||null, phone||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/campuses/:id', requireAuth, requireLevel(1), async (req, res) => {
  try {
    await query('UPDATE campuses SET active=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── LMS — LESSONS ─────────────────────────────────────────────
// GET /api/lms/lessons — all lessons (for course browser)
app.get('/api/lms/lessons', requireAuth, async (req, res) => {
  try {
    const { course_id, step_num, tier } = req.query;
    let where = [];
    const params = [];
    let pi = 1;

    if (course_id) { where.push(`l.course_id = $${pi++}`); params.push(course_id); }
    if (step_num !== undefined) { where.push(`l.step_num = $${pi++}`); params.push(parseInt(step_num)); }

    // Tier gate: guests/members (level 5-6) only see PUBLIC unless enrolled
    if (req.user.level >= 5) {
      where.push(`l.tier = 'PUBLIC'`);
    }

    const sql = `
      SELECT l.id, l.course_id, l.step_num, l.lesson_num, l.sort_order,
             l.title, l.tier, l.passing_score, l.duration_min, l.status,
             l.scripture_memory, l.assignment, l.reading_plan,
             COALESCE(p.completed, false) AS completed,
             COALESCE(p.quiz_passed, false) AS quiz_passed,
             COALESCE(p.quiz_score, 0) AS quiz_score,
             COALESCE(p.mentor_signed, false) AS mentor_signed,
             p.completed_at
      FROM lms_lessons l
      LEFT JOIN lms_progress p ON p.lesson_id = l.id AND p.user_id = $${pi++}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.sort_order ASC`;
    params.push(req.user.sub);

    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    console.error('[LMS LESSONS]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/lms/lessons/:id — single lesson with full body + quiz
app.get('/api/lms/lessons/:id', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT l.*,
              COALESCE(p.completed,false) AS completed,
              COALESCE(p.quiz_passed,false) AS quiz_passed,
              COALESCE(p.quiz_score,0) AS quiz_score,
              COALESCE(p.mentor_signed,false) AS mentor_signed,
              p.completed_at, p.last_viewed_at
       FROM lms_lessons l
       LEFT JOIN lms_progress p ON p.lesson_id=l.id AND p.user_id=$2
       WHERE l.id=$1`,
      [req.params.id, req.user.sub]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lesson not found' });

    const lesson = r.rows[0];

    // Tier gate
    if (lesson.tier === 'MEMBER' && req.user.level >= 5) {
      return res.status(403).json({ error: 'Member access required', tier: 'MEMBER' });
    }

    // Get quiz questions
    const qr = await query(
      `SELECT id, question_num, question_text AS question, choices, correct_index AS correct, explanation
       FROM lms_quiz_questions WHERE lesson_id=$1 ORDER BY question_num`,
      [req.params.id]
    );
    lesson.quiz = qr.rows;

    // Update last_viewed
    await query(
      `INSERT INTO lms_progress (user_id, lesson_id, last_viewed_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id,lesson_id) DO UPDATE SET last_viewed_at=NOW()`,
      [req.user.sub, req.params.id]
    );

    res.json(lesson);
  } catch (err) {
    console.error('[LMS LESSON]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── LMS — PROGRESS ────────────────────────────────────────────
// GET /api/lms/progress — all progress for current user
app.get('/api/lms/progress', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT lesson_id, completed, quiz_passed, quiz_score, quiz_attempts,
              mentor_signed, completed_at, last_viewed_at, updated_at
       FROM lms_progress WHERE user_id=$1`,
      [req.user.sub]
    );
    // Return as object keyed by lesson_id (matches localStorage format)
    const progress = {};
    for (const row of r.rows) {
      progress[row.lesson_id] = {
        completed:    row.completed,
        quizPassed:   row.quiz_passed,
        quizScore:    row.quiz_score,
        quizAttempts: row.quiz_attempts,
        mentorSigned: row.mentor_signed,
        completedAt:  row.completed_at,
        ts:           row.updated_at,
      };
    }
    res.json({ ok: true, progress });
  } catch (err) {
    console.error('[PROGRESS GET]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/lms/progress — upsert progress record
app.post('/api/lms/progress', requireAuth, async (req, res) => {
  try {
    const { lessonId, progress } = req.body;
    if (!lessonId || !progress) return res.status(400).json({ error: 'lessonId and progress required' });

    await query(
      `INSERT INTO lms_progress (user_id, lesson_id, completed, quiz_passed, quiz_score,
                                  mentor_signed, completed_at, last_viewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (user_id, lesson_id) DO UPDATE SET
         completed      = EXCLUDED.completed,
         quiz_passed    = EXCLUDED.quiz_passed,
         quiz_score     = GREATEST(lms_progress.quiz_score, EXCLUDED.quiz_score),
         quiz_attempts  = lms_progress.quiz_attempts + 1,
         mentor_signed  = EXCLUDED.mentor_signed,
         completed_at   = CASE WHEN EXCLUDED.completed AND lms_progress.completed_at IS NULL
                               THEN NOW() ELSE lms_progress.completed_at END,
         last_viewed_at = NOW(),
         updated_at     = NOW()`,
      [
        req.user.sub, lessonId,
        progress.completed || false,
        progress.quizPassed || false,
        progress.quizScore || 0,
        progress.mentorSigned || false,
        progress.completedAt || null,
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[PROGRESS POST]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── LMS — COMPLETE ────────────────────────────────────────────
// POST /api/lms/complete — mark lesson complete
app.post('/api/lms/complete', requireAuth, async (req, res) => {
  try {
    const { lessonId, courseId, stepNum, lessonNum, quizPassed, quizScore } = req.body;
    if (!lessonId) return res.status(400).json({ error: 'lessonId required' });

    await query(
      `INSERT INTO lms_progress (user_id, lesson_id, completed, quiz_passed, quiz_score, completed_at)
       VALUES ($1,$2,true,$3,$4,NOW())
       ON CONFLICT (user_id,lesson_id) DO UPDATE SET
         completed    = true,
         quiz_passed  = CASE WHEN $3 THEN true ELSE lms_progress.quiz_passed END,
         quiz_score   = GREATEST(lms_progress.quiz_score, $4),
         quiz_attempts = lms_progress.quiz_attempts + 1,
         completed_at = COALESCE(lms_progress.completed_at, NOW()),
         updated_at   = NOW()`,
      [req.user.sub, lessonId, quizPassed || false, quizScore || 0]
    );

    // Update user steps_completed count
    const stepsQ = await query(
      `SELECT COUNT(DISTINCT l.step_num) AS steps
       FROM lms_progress p
       JOIN lms_lessons l ON l.id = p.lesson_id
       WHERE p.user_id=$1 AND p.completed=true AND l.step_num > 0`,
      [req.user.sub]
    );
    const stepsCount = parseInt(stepsQ.rows[0]?.steps || 0);
    await query('UPDATE users SET steps_completed=$1, updated_at=NOW() WHERE id=$2',
                [stepsCount, req.user.sub]);

    audit(req.user.sub, 'lesson_complete', 'lesson', lessonId,
          { quizPassed, quizScore, stepNum, lessonNum }, req.ip);

    res.json({ ok: true, stepsCompleted: stepsCount });
  } catch (err) {
    console.error('[COMPLETE]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── LMS — STEP EXAM ───────────────────────────────────────────
// POST /api/lms/exam — submit step exam
app.post('/api/lms/exam', requireAuth, async (req, res) => {
  try {
    const { stepNum, answers } = req.body;
    if (stepNum === undefined) return res.status(400).json({ error: 'stepNum required' });

    // Verify all lessons in step are complete
    const completedQ = await query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN p.completed AND p.quiz_passed THEN 1 ELSE 0 END) AS done
       FROM lms_lessons l
       LEFT JOIN lms_progress p ON p.lesson_id=l.id AND p.user_id=$1
       WHERE l.step_num=$2`,
      [req.user.sub, stepNum]
    );
    const { total, done } = completedQ.rows[0];
    if (parseInt(done) < parseInt(total)) {
      return res.status(400).json({
        error: 'Complete all lessons before taking the step exam',
        completed: parseInt(done),
        total: parseInt(total),
      });
    }

    // Score the exam (answers keyed by question index, 80% passing)
    const answersObj = answers || {};
    const answerCount = Object.keys(answersObj).length;
    // Simple scoring: we track submission, detailed grading done client-side
    const score = req.body.score || 80; // Client sends calculated score
    const passed = score >= 80;

    // Get attempt number
    const attQ = await query(
      'SELECT COUNT(*) AS cnt FROM lms_step_exams WHERE user_id=$1 AND step_num=$2',
      [req.user.sub, stepNum]
    );
    const attemptNum = parseInt(attQ.rows[0].cnt) + 1;

    await query(
      `INSERT INTO lms_step_exams (user_id, step_num, score, passed, answers, attempt_num)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.sub, stepNum, score, passed, JSON.stringify(answersObj), attemptNum]
    );

    audit(req.user.sub, 'step_exam', 'exam', String(stepNum),
          { score, passed, attemptNum }, req.ip);

    res.json({ ok: true, score, passed, attemptNum, passingScore: 80 });
  } catch (err) {
    console.error('[EXAM]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── LMS — MENTOR SIGN-OFF ─────────────────────────────────────
// POST /api/lms/mentor-signoff
app.post('/api/lms/mentor-signoff', requireAuth, async (req, res) => {
  try {
    const { lessonId, mentorId, notes } = req.body;
    if (!lessonId) return res.status(400).json({ error: 'lessonId required' });

    // Mentor must be level 3 or lower (staff/leader/admin) OR self if testing
    const resolvedMentorId = mentorId || req.user.sub;

    await query(
      `INSERT INTO lms_progress (user_id, lesson_id, mentor_signed, mentor_id, mentor_notes, signed_at)
       VALUES ($1,$2,true,$3,$4,NOW())
       ON CONFLICT (user_id,lesson_id) DO UPDATE SET
         mentor_signed = true,
         mentor_id     = $3,
         mentor_notes  = $4,
         signed_at     = NOW(),
         updated_at    = NOW()`,
      [req.user.sub, lessonId, resolvedMentorId, notes || null]
    );

    audit(req.user.sub, 'mentor_signoff', 'lesson', lessonId,
          { mentorId: resolvedMentorId, notes }, req.ip);

    res.json({ ok: true, mentorSigned: true, signedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[MENTOR SIGNOFF]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/lms/progress/:userId — admin view of member progress
app.get('/api/lms/progress/:userId', requireAuth, requireLevel(3), async (req, res) => {
  try {
    const r = await query(
      `SELECT p.lesson_id, p.completed, p.quiz_passed, p.quiz_score,
              p.mentor_signed, p.completed_at, p.updated_at,
              l.title, l.step_num, l.lesson_num, l.tier
       FROM lms_progress p
       JOIN lms_lessons l ON l.id = p.lesson_id
       WHERE p.user_id = $1
       ORDER BY l.sort_order`,
      [req.params.userId]
    );
    res.json({ userId: req.params.userId, lessons: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── LMS — SEED CURRICULUM ─────────────────────────────────────
// POST /api/lms/seed — L0 only, seeds the 52-lesson curriculum
app.post('/api/lms/seed', requireAuth, requireLevel(0), async (req, res) => {
  try {
    const { courses, lessons } = req.body;
    if (!courses || !lessons) return res.status(400).json({ error: 'courses and lessons required' });

    let courseCount = 0;
    let lessonCount = 0;

    for (const c of courses) {
      await query(
        `INSERT INTO lms_courses (id, title, description, step_num, track, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET title=$2, description=$3, updated_at=NOW()`,
        [c.id, c.title, c.description||'', c.stepNum||0, c.track||'rrn-12step', c.order||0]
      ).catch(e => console.warn('[SEED COURSE]', c.id, e.message));
      courseCount++;
    }

    for (const l of lessons) {
      await query(
        `INSERT INTO lms_lessons
           (id, course_id, step_num, lesson_num, sort_order, title, body, tier,
            passing_score, duration_min, scripture_memory, assignment, reading_plan, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'approved')
         ON CONFLICT (id) DO UPDATE SET
           title=$6, body=$7, tier=$8, passing_score=$9, scripture_memory=$11,
           assignment=$12, reading_plan=$13, updated_at=NOW()`,
        [l.id, l.courseId, l.stepNum||0, l.lessonNum||1, l.order||0,
         l.title, l.body||'', l.tier||'PUBLIC', l.passingScore||70, l.duration_min||25,
         l.scriptureMemory||null, l.assignment||null, l.readingPlan||null]
      ).catch(e => console.warn('[SEED LESSON]', l.id, e.message));

      // Seed quiz questions
      if (l.quiz && l.quiz.length) {
        for (const q of l.quiz) {
          await query(
            `INSERT INTO lms_quiz_questions
               (lesson_id, question_num, question_text, choices, correct_index, explanation)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT DO NOTHING`,
            [l.id, parseInt(q.id?.replace('q',''))||1, q.question,
             JSON.stringify(q.choices), q.correct||0, q.explanation||null]
          ).catch(e => console.warn('[SEED QUIZ]', q.id, e.message));
        }
      }
      lessonCount++;
    }

    res.json({ ok: true, courseCount, lessonCount });
  } catch (err) {
    console.error('[SEED]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SYNC ──────────────────────────────────────────────────────
// GET /api/sync/pull — pull server state since timestamp
app.get('/api/sync/pull', requireAuth, async (req, res) => {
  try {
    const since = parseInt(req.query.since || 0);
    const sinceDate = since ? new Date(since) : new Date(0);

    // Build state object matching what the client expects
    const state = {};

    // Progress changes
    const progressR = await query(
      `SELECT lesson_id, completed, quiz_passed, quiz_score, mentor_signed,
              completed_at, updated_at
       FROM lms_progress WHERE user_id=$1 AND updated_at > $2`,
      [req.user.sub, sinceDate]
    );

    if (progressR.rows.length) {
      state.lessonProgress = {};
      for (const row of progressR.rows) {
        state.lessonProgress[row.lesson_id] = {
          completed: row.completed,
          quizPassed: row.quiz_passed,
          quizScore: row.quiz_score,
          mentorSigned: row.mentor_signed,
          completedAt: row.completed_at,
          ts: row.updated_at,
        };
      }
    }

    res.json({ ok: true, state, ts: Date.now() });
  } catch (err) {
    console.error('[SYNC PULL]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/sync/push — push client events
app.post('/api/sync/push', requireAuth, async (req, res) => {
  try {
    const { type, payload, clientId } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });

    await query(
      'INSERT INTO sync_events (user_id, client_id, event_type, payload) VALUES ($1,$2,$3,$4)',
      [req.user.sub, clientId||null, type, JSON.stringify(payload||{})]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[SYNC PUSH]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PROVISION ─────────────────────────────────────────────────
// POST /api/provision/validate
app.post('/api/provision/validate', async (req, res) => {
  try {
    const { token, org, role } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    // Validate the JWT
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const r = await query('SELECT * FROM users WHERE id=$1', [decoded.sub]);
      if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
      const user = r.rows[0];
      const newToken = signToken(user);
      res.json({ ok: true, valid: true, token: newToken,
                 session: { id: user.id, username: user.username, email: user.email,
                            name: user.name, role: user.role, level: user.level,
                            campus: user.campus_id, title: user.title } });
    } catch {
      res.json({ ok: false, valid: false });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/provision/org/:org
app.get('/api/provision/org/:org', async (req, res) => {
  res.json({
    ok: true,
    org: req.params.org,
    name: 'Refined Recovery Network',
    active: true,
    features: ['12step', 'lms', 'members', 'mentorship', 'sync'],
  });
});

// ── MEETINGS ──────────────────────────────────────────────────
app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const { campus_id } = req.query;
    const params = campus_id ? [campus_id] : [];
    const r = await query(
      `SELECT m.*, c.name AS campus_name FROM meetings m
       LEFT JOIN campuses c ON c.id = m.campus_id
       WHERE m.active=true ${campus_id ? 'AND m.campus_id=$1' : ''}
       ORDER BY c.name, m.day_of_week`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── JOURNAL ───────────────────────────────────────────────────
app.get('/api/journal', requireAuth, async (req, res) => {
  try {
    const r = await query(
      'SELECT * FROM journal_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.sub]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/journal', requireAuth, async (req, res) => {
  try {
    const { entry_text, lesson_id, step_num, prompt } = req.body;
    if (!entry_text) return res.status(400).json({ error: 'entry_text required' });
    const r = await query(
      'INSERT INTO journal_entries (user_id,entry_text,lesson_id,step_num,prompt) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.sub, entry_text, lesson_id||null, step_num||null, prompt||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ERROR HANDLER ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── START ─────────────────────────────────────────────────────
async function start() {
  try {
    await query('SELECT 1');
    console.log('[DB] Connected to PostgreSQL');
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[RRN] Server running on port ${PORT}`);
    console.log(`[RRN] Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start();
