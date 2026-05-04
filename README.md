# Refined Recovery Network — Backend Deployment Guide

## Railway Deployment

### 1. Environment Variables (set in Railway dashboard)

```
DATABASE_URL          = (auto-set by Railway PostgreSQL plugin)
JWT_SECRET            = (generate: openssl rand -hex 64)
JWT_EXPIRES           = 7d
NODE_ENV              = production
PORT                  = 3000
ALLOWED_ORIGINS       = https://refinedrecovery.com,https://chuckedwards1972.github.io
```

### 2. Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to existing project (romantic-enchantment)
railway link

# Deploy
railway up
```

### 3. Run Database Schema

```bash
# Get your DATABASE_URL from Railway dashboard, then:
railway run psql $DATABASE_URL -f schema.sql
```

Or connect via Railway's built-in PostgreSQL console and paste schema.sql contents.

### 4. Seed the 52-Lesson Curriculum

After deployment:

```bash
# From the rrn-backend directory
API_BASE=https://hope-recovery-backend-production.up.railway.app/api \
ADMIN_USER=RRNHQ \
ADMIN_PASS=ACTS2:38 \
node seed-curriculum.js
```

## API Reference

### Authentication
```
POST /api/auth                    Login (username/email + password)
POST /api/auth/register           Self-register as member
GET  /api/auth/me                 Get current user (requires token)
POST /api/auth/logout             Logout
```

### Members (requires auth + level ≤ 4)
```
GET    /api/members               List members
POST   /api/members               Create member (level ≤ 3)
GET    /api/members/:id           Get member
PATCH  /api/members/:id           Update member (level ≤ 3)
```

### Campuses (requires auth + level ≤ 2)
```
GET    /api/admin/campuses        List campuses
POST   /api/admin/campuses        Create campus (level ≤ 1)
DELETE /api/admin/campuses/:id    Deactivate campus (level ≤ 1)
```

### LMS — Lessons
```
GET  /api/lms/lessons             All lessons (tier-gated by role)
GET  /api/lms/lessons/:id         Single lesson with quiz + progress
```

### LMS — Progress
```
GET  /api/lms/progress            Current user's full progress map
POST /api/lms/progress            Upsert progress record
POST /api/lms/complete            Mark lesson complete
POST /api/lms/exam                Submit step exam
POST /api/lms/mentor-signoff      Mentor signs off on lesson
GET  /api/lms/progress/:userId    Admin view of member progress (level ≤ 3)
```

### Sync
```
GET  /api/sync/pull?since=        Pull state changes since timestamp
POST /api/sync/push               Push client events
```

### Other
```
POST /api/provision/validate      Validate token
GET  /api/provision/org/:org      Get org config
GET  /api/meetings                List meetings
GET  /api/journal                 Get user journal entries
POST /api/journal                 Create journal entry
GET  /api/health                  Health check
```

## Role Levels

| Level | Role           | Access                        |
|-------|----------------|-------------------------------|
| 0     | platform_owner | Everything                    |
| 1     | hq_admin       | All campuses, all admin       |
| 2     | director       | Campus director               |
| 3     | leader         | Staff management              |
| 4     | staff          | Read members, mentor          |
| 5     | member         | Own progress, public lessons  |
| 6     | guest          | Public content only           |

## Default Login (L0)

```
Username: RRNHQ
Password: ACTS2:38
```

**Change this password immediately after first deployment.**

## Tier Gate Logic

- `PUBLIC` lessons: accessible to all authenticated users (level 0-6)
- `MEMBER` lessons: accessible to level 0-4 only (platform_owner through staff)
- Level 5 (member) sees MEMBER lessons only after mentor sign-off on prior PUBLIC lesson
- Level 6 (guest) sees PUBLIC lessons only
