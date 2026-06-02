const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.argv[2];
if (!DATABASE_URL) { console.error('Usage: node seed_db.js DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    console.log('Connected');

    // Check existing tables
    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log('Tables:', tables.rows.map(r => r.table_name).join(', '));

    // Check if users table has username column
    const cols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position"
    ).catch(() => ({ rows: [] }));
    console.log('Users cols:', cols.rows.map(r => r.column_name).join(', ') || 'TABLE MISSING');

    // Add username column if missing
    if (cols.rows.length > 0 && !cols.rows.find(r => r.column_name === 'username')) {
      console.log('Adding username column...');
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE");
      await client.query("UPDATE users SET username=email WHERE username IS NULL");
      console.log('Username column added');
    }

    // Add any other missing columns
    const missingCols = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS current_step INTEGER DEFAULT 1",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pipeline_stage INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS steps_completed INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS attendance_count INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS sobriety_date DATE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS join_date DATE DEFAULT CURRENT_DATE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT DEFAULT 'Member'",
    ];
    for (const sql of missingCols) {
      await client.query(sql).catch(e => console.log('Skip:', e.message.split('\n')[0]));
    }

    // Check if RRNHQ exists
    const existing = await client.query(
      "SELECT id, username, email, role, level FROM users WHERE username='RRNHQ' OR email='bro.chuck.edwards@gmail.com' LIMIT 1"
    ).catch(() => ({ rows: [] }));

    if (existing.rows.length > 0) {
      console.log('RRNHQ exists:', JSON.stringify(existing.rows[0]));
      // Update password to make sure it's correct
      const hash = await bcrypt.hash('ACTS2:38', 12);
      await client.query(
        "UPDATE users SET password_hash=$1, username='RRNHQ', role='platform_owner', level=0 WHERE id=$2",
        [hash, existing.rows[0].id]
      );
      console.log('RRNHQ updated - password reset to ACTS2:38');
    } else {
      console.log('Creating RRNHQ...');
      const hash = await bcrypt.hash('ACTS2:38', 12);
      await client.query(
        `INSERT INTO users (username, email, password_hash, name, role, level, title)
         VALUES ('RRNHQ', 'bro.chuck.edwards@gmail.com', $1, 'Chuck Edwards', 'platform_owner', 0, 'Platform Owner')`,
        [hash]
      );
      console.log('RRNHQ created');
    }

    // Verify login works
    const user = await client.query(
      "SELECT id, username, email, role, level, password_hash FROM users WHERE username='RRNHQ'"
    );
    if (user.rows.length) {
      const valid = await bcrypt.compare('ACTS2:38', user.rows[0].password_hash);
      console.log('Login test:', valid ? 'PASS' : 'FAIL');
      console.log('User:', user.rows[0].username, 'role:', user.rows[0].role, 'level:', user.rows[0].level);
    }

    console.log('DONE');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
