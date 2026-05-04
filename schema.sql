-- ============================================================
-- REFINED RECOVERY NETWORK — Production Database Schema
-- Railway PostgreSQL
-- ============================================================

-- ── EXTENSIONS ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── CAMPUSES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campuses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  city        TEXT,
  state       TEXT DEFAULT 'LA',
  address     TEXT,
  phone       TEXT,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO campuses (id, name, city, state) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Port Allen',  'Port Allen',  'LA'),
  ('00000000-0000-0000-0000-000000000002', 'Thibodaux',   'Thibodaux',   'LA'),
  ('00000000-0000-0000-0000-000000000003', 'Pineville',   'Pineville',   'LA'),
  ('00000000-0000-0000-0000-000000000004', 'LaPlace',     'LaPlace',     'LA')
ON CONFLICT (id) DO NOTHING;

-- ── USERS ─────────────────────────────────────────────────────
-- Roles: 0=platform_owner, 1=hq_admin, 2=director, 3=leader, 4=staff, 5=member, 6=guest
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member'
                  CHECK (role IN ('platform_owner','hq_admin','director','leader','staff','member','guest')),
  level         INTEGER NOT NULL DEFAULT 5 CHECK (level BETWEEN 0 AND 6),
  campus_id     UUID REFERENCES campuses(id),
  title         TEXT DEFAULT 'Member',
  phone         TEXT,
  status        TEXT DEFAULT 'Active'
                  CHECK (status IN ('Active','Inactive','Intake','Graduated','Suspended')),
  sobriety_date DATE,
  join_date     DATE DEFAULT CURRENT_DATE,
  pipeline_stage INTEGER DEFAULT 0,
  steps_completed INTEGER DEFAULT 0,
  attendance_count INTEGER DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Seed L0 account
INSERT INTO users (
  username, email, password_hash, name, role, level, title
) VALUES (
  'RRNHQ',
  'admin@refinedrecovery.com',
  crypt('ACTS2:38', gen_salt('bf', 12)),
  'RRN Headquarters',
  'platform_owner',
  0,
  'Platform Owner'
) ON CONFLICT (username) DO NOTHING;

-- ── SESSIONS / TOKENS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON user_sessions(user_id);

-- ── PROGRAMS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS programs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  description TEXT,
  track       TEXT NOT NULL DEFAULT 'rrn-12step',
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO programs (id, name, description, track) VALUES
  ('00000000-0000-0000-0001-000000000001', '12-Step Recovery Track', 'Biblical 12-step recovery program', 'rrn-12step'),
  ('00000000-0000-0000-0001-000000000002', 'Leadership Track',       'Chair → Ambassador progression',    'leadership'),
  ('00000000-0000-0000-0001-000000000003', 'Workforce Readiness',    'Job prep and placement',            'workforce')
ON CONFLICT (id) DO NOTHING;

-- ── LMS COURSES ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms_courses (
  id          TEXT PRIMARY KEY,   -- e.g. "rrn-preface", "rrn-s1"
  program_id  UUID REFERENCES programs(id),
  title       TEXT NOT NULL,
  description TEXT,
  step_num    INTEGER,            -- 0=Preface, 1-12=Steps
  track       TEXT DEFAULT 'rrn-12step',
  sort_order  INTEGER DEFAULT 0,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── LMS LESSONS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms_lessons (
  id            TEXT PRIMARY KEY,  -- e.g. "rrn-preface-l1", "rrn-s1-l1"
  course_id     TEXT NOT NULL REFERENCES lms_courses(id),
  step_num      INTEGER NOT NULL DEFAULT 0,
  lesson_num    INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,
  body          TEXT,              -- HTML body
  tier          TEXT DEFAULT 'PUBLIC' CHECK (tier IN ('PUBLIC','MEMBER')),
  passing_score INTEGER DEFAULT 70,
  duration_min  INTEGER DEFAULT 25,
  scripture_memory TEXT,
  assignment    TEXT,
  reading_plan  TEXT,
  status        TEXT DEFAULT 'approved',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── LMS QUIZ QUESTIONS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms_quiz_questions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id     TEXT NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  question_num  INTEGER NOT NULL DEFAULT 1,
  question_text TEXT NOT NULL,
  choices       JSONB NOT NULL DEFAULT '[]',   -- array of strings
  correct_index INTEGER NOT NULL DEFAULT 0,
  explanation   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_lesson ON lms_quiz_questions(lesson_id);

-- ── LMS ENROLLMENTS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms_enrollments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   TEXT NOT NULL REFERENCES lms_courses(id),
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, course_id)
);

-- ── LMS LESSON PROGRESS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms_progress (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id       TEXT NOT NULL REFERENCES lms_lessons(id),
  completed       BOOLEAN DEFAULT false,
  quiz_passed     BOOLEAN DEFAULT false,
  quiz_score      INTEGER DEFAULT 0,
  quiz_attempts   INTEGER DEFAULT 0,
  mentor_signed   BOOLEAN DEFAULT false,
  mentor_id       UUID REFERENCES users(id),
  mentor_notes    TEXT,
  signed_at       TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  last_viewed_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_user   ON lms_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_progress_lesson ON lms_progress(lesson_id);

-- ── LMS STEP EXAMS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms_step_exams (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_num    INTEGER NOT NULL,
  score       INTEGER DEFAULT 0,
  passed      BOOLEAN DEFAULT false,
  answers     JSONB DEFAULT '{}',
  attempt_num INTEGER DEFAULT 1,
  taken_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, step_num, attempt_num)
);

-- ── MENTORSHIP ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mentor_assignments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mentor_id   UUID NOT NULL REFERENCES users(id),
  mentee_id   UUID NOT NULL REFERENCES users(id),
  campus_id   UUID REFERENCES campuses(id),
  active      BOOLEAN DEFAULT true,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(mentor_id, mentee_id)
);

-- ── MEETINGS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campus_id   UUID REFERENCES campuses(id),
  title       TEXT NOT NULL,
  day_of_week TEXT,
  time_of_day TEXT,
  location    TEXT,
  meeting_type TEXT DEFAULT 'step-study',
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── SYNC / EVENTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id),
  client_id   TEXT,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  processed   BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_user    ON sync_events(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_created ON sync_events(created_at);

-- ── JOURNAL ENTRIES ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id   TEXT REFERENCES lms_lessons(id),
  step_num    INTEGER,
  entry_text  TEXT NOT NULL,
  prompt      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUDIT LOG ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     JSONB DEFAULT '{}',
  ip_address  INET,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_lessons_updated
  BEFORE UPDATE ON lms_lessons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_progress_updated
  BEFORE UPDATE ON lms_progress
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── VIEWS ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW member_progress_summary AS
SELECT
  u.id AS user_id,
  u.name,
  u.campus_id,
  COUNT(DISTINCT p.lesson_id) FILTER (WHERE p.completed) AS lessons_completed,
  COUNT(DISTINCT ll.id) AS lessons_total,
  COUNT(DISTINCT p.lesson_id) FILTER (WHERE p.quiz_passed) AS quizzes_passed,
  COUNT(DISTINCT se.step_num) FILTER (WHERE se.passed) AS steps_exam_passed,
  MAX(p.completed_at) AS last_activity
FROM users u
LEFT JOIN lms_progress p ON p.user_id = u.id
LEFT JOIN lms_lessons ll ON ll.id = p.lesson_id
LEFT JOIN lms_step_exams se ON se.user_id = u.id AND se.passed = true
WHERE u.role IN ('member','staff','leader')
GROUP BY u.id, u.name, u.campus_id;
