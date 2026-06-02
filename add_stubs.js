const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
let s = fs.readFileSync(serverPath, 'utf8');

if (s.includes('/api/health')) {
  console.log('Stubs already present — skipping');
  process.exit(0);
}

const stubs = [
  "app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));",
  "app.get('/health',     (req, res) => res.json({ ok: true }));",
  "app.get('/api/testimonies/featured', (req, res) => res.json([]));",
  "app.get('/api/sync/pull', (req, res) => res.json({ events: [], since: req.query.since || 0 }));",
  "app.get('/api/lms/progress', requireAuth, (req, res) => res.json({ progress: {} }));",
].join('\n') + '\n\n';

s = s.replace('app.listen(', stubs + 'app.listen(');
fs.writeFileSync(serverPath, s, 'utf8');
console.log('Stubs added successfully');
