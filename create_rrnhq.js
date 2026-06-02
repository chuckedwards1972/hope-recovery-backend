const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DB = 'postgresql://postgres:jbDvuGAGMQuzwqvZdtAwRcTokPMtpOuT@shuttle.proxy.rlwy.net:21783/railway';
const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    const hash = await bcrypt.hash('ACTS2:38', 12);
    
    const sql = `
      INSERT INTO users (id, email, name, password, role, username, title, "isActive", level)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, true, 0)
      ON CONFLICT (email) DO UPDATE SET
        password = $3,
        username = $5,
        role = $4,
        title = $6,
        level = 0,
        "isActive" = true
      RETURNING id, username, email, role, level
    `;
    
    const r = await client.query(sql, [
      'bro.chuck.edwards@gmail.com',
      'Chuck Edwards',
      hash,
      'platform_owner',
      'RRNHQ',
      'Platform Owner'
    ]);
    
    console.log('RRNHQ ready:', JSON.stringify(r.rows[0]));
    
    // Verify password
    const verify = await client.query('SELECT password FROM users WHERE username=$1', ['RRNHQ']);
    const valid = await bcrypt.compare('ACTS2:38', verify.rows[0].password);
    console.log('Password check:', valid ? 'PASS' : 'FAIL');
    
    // Show all users
    const all = await client.query('SELECT username, email, role, level FROM users ORDER BY level');
    console.log('All users:');
    all.rows.forEach(u => console.log(' ', u.username, u.email, u.role, u.level));
    
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
