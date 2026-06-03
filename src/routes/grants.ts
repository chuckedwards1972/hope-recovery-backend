import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../lib/prisma';

const router = Router();

router.get('/', authenticate, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT id, name, amount, source, type, status,
             "awardedDate", "expiresDate", notes, "isActive", "createdAt", "updatedAt"
      FROM grants ORDER BY "createdAt" DESC
    `;
    res.json(rows.map((r: any) => ({
      id: r.id, grantId: r.id, grantName: r.name, agency: r.source,
      amount: r.amount ? String(r.amount) : null, type: r.type, status: r.status,
      appliedAt: r.createdAt, deadline: r.expiresDate, awardExpected: r.awardedDate,
      notes: r.notes, autoData: {}, createdAt: r.createdAt, updatedAt: r.updatedAt
    })));
  } catch (e: any) {
    console.error('[RRN] GET /grants error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    const rows = await prisma.$queryRaw<any[]>`
      INSERT INTO grants(id, name, amount, source, type, status, notes, "expiresDate", "awardedDate", "isActive", "createdAt", "updatedAt")
      VALUES(gen_random_uuid()::text, ${b.grantName||b.name||'Grant'}, ${parseFloat(b.amount)||0},
             ${b.agency||b.source||null}, ${b.type||'Federal'}, ${b.status||'applied'},
             ${b.notes||null}, ${b.deadline||null}, ${b.awardExpected||null}, true, NOW(), NOW())
      RETURNING *
    `;
    const r = rows[0];
    res.status(201).json({ id: r.id, grantId: r.id, grantName: r.name, agency: r.source, status: r.status, appliedAt: r.createdAt });
  } catch (e: any) {
    console.error('[RRN] POST /grants error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    const rows = await prisma.$queryRaw<any[]>`
      UPDATE grants SET
        status = COALESCE(${b.status||null}, status),
        notes  = COALESCE(${b.notes||null}, notes),
        "updatedAt" = NOW()
      WHERE id = ${req.params.id} RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, grant: rows[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    await prisma.$queryRaw`DELETE FROM grants WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
