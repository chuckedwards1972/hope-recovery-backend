const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DB = process.argv[2];
if (!DB) { console.error('Need DB URL'); process.exit(1); }

const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    // Show real columns
    const cols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position"
    );
    console.log('Users cols:', cols.rows.map(r => r.column_name).join(', '));

    // Add missing columns using actual column name 'password'
    const alters = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 5",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS campus_id TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT DEFAULT 'Member'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Active'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS current_step INTEGER DEFAULT 1",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS steps_completed INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS sobriety_date DATE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT",
    ];
    for (const sql of alters) {
      await client.query(sql).catch(e => console.log('Skip:', e.message.split('\n')[0]));
    }

    // Set username = email for existing users
    await client.query("UPDATE users SET username=email WHERE username IS NULL");

    // Check if RRNHQ exists
    const existing = await client.query(
      "SELECT id, email, role FROM users WHERE email='bro.chuck.edwards@gmail.com' OR username='RRNHQ' LIMIT 1"
    ).catch(() => ({ rows: [] }));

    const hash = await bcrypt.hash('ACTS2:38', 12);

    if (existing.rows.length > 0) {
      console.log('User exists, updating...');
      await client.query(
        "UPDATE users SET password=$1, username='RRNHQ', role='platform_owner', level=0, title='Platform Owner', \"isActive\"=true WHERE id=$2",
        [hash, existing.rows[0].id]
      );
      console.log('Updated RRNHQ - password=ACTS2:38');
    } else {
      console.log('Creating RRNHQ...');
      await client.query(
        `INSERT INTO users (email, name, password, role, level, username, title, "isActive")
         VALUES ('bro.chuck.edwards@gmail.com', 'Chuck Edwards', $1, 'platform_owner', 0, 'RRNHQ', 'Platform Owner', true)`,
        [hash]
      );
      console.log('RRNHQ created');
    }

    // Verify
    const user = await client.query("SELECT id, username, email, role, level, password FROM users WHERE username='RRNHQ'");
    if (user.rows.length) {
      const valid = await bcrypt.compare('ACTS2:38', user.rows[0].password);
      console.log('Password test:', valid ? 'PASS' : 'FAIL');
      console.log('User:', user.rows[0].username, 'role:', user.rows[0].role, 'level:', user.rows[0].level);
    }

    // Show all users
    const all = await client.query("SELECT username, email, role, level FROM users LIMIT 10");
    console.log('All users:', JSON.stringify(all.rows));

    console.log('DONE');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
