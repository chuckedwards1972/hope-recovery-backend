import re

f = r"C:\Users\broch\RRN-Backend-Deploy\server.js"

with open(f, encoding='utf-8') as fh:
    c = fh.read()

# Fix meetings query - remove active=true filter and campus join, use safe fallback
old = """app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const { campus_id } = req.query;
    const params = campus_id ? [campus_id] : [];
    const r = await query(
      `SELECT m.* FROM meetings m
       WHERE m.active=true ${campus_id ? 'AND m.campus_id=$1' : ''}
       ORDER BY m.day_of_week`,
      params
    );
    res.json(r.rows);"""

new = """app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const { campus_id } = req.query;
    let r;
    if (campus_id) {
      r = await query('SELECT * FROM meetings WHERE campus_id=$1 ORDER BY id', [campus_id]);
    } else {
      r = await query('SELECT * FROM meetings ORDER BY id', []);
    }
    res.json(r.rows);"""

if old in c:
    c = c.replace(old, new, 1)
    print("Fixed meetings query")
else:
    # Try simpler replacement
    print("Pattern not found exactly, trying simpler fix")
    c = re.sub(
        r"app\.get\('/api/meetings'.*?res\.json\(r\.rows\);",
        """app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const { campus_id } = req.query;
    const r = campus_id
      ? await query('SELECT * FROM meetings WHERE campus_id=$1 ORDER BY id', [campus_id])
      : await query('SELECT * FROM meetings ORDER BY id', []);
    res.json(r.rows);""",
        c, count=1, flags=re.DOTALL
    )
    print("Applied regex fix")

with open(f, 'w', encoding='utf-8') as fh:
    fh.write(c)

import subprocess
r = subprocess.run(['node', '--check', f], capture_output=True, text=True)
print('Syntax:', 'OK' if r.returncode == 0 else r.stderr[:200])
print('DONE')
