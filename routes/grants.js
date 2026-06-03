const express = require("express");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { rows } = await req.db.query(
      'SELECT id,name,amount,source,type,status,"awardedDate","expiresDate",notes,"createdAt","updatedAt" FROM grants ORDER BY "createdAt" DESC'
    );
    res.json(rows.map(r => ({
      id: r.id, grantId: r.id, grantName: r.name, agency: r.source,
      amount: r.amount ? String(r.amount) : null, type: r.type, status: r.status,
      appliedAt: r.createdAt, deadline: r.expiresDate, awardExpected: r.awardedDate,
      notes: r.notes, autoData: {}, createdAt: r.createdAt, updatedAt: r.updatedAt
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await req.db.query(
      'INSERT INTO grants(id,name,amount,source,type,status,notes,"expiresDate","awardedDate","isActive","createdAt","updatedAt") VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW()) RETURNING *',
      [b.grantName||b.name||"Grant", parseFloat(b.amount)||0, b.agency||b.source||null,
       b.type||"Federal", b.status||"applied", b.notes||null, b.deadline||null, b.awardExpected||null]
    );
    const r = rows[0];
    res.status(201).json({ id: r.id, grantId: r.id, grantName: r.name, agency: r.source, status: r.status, appliedAt: r.createdAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await req.db.query(
      'UPDATE grants SET status=COALESCE($2,status),notes=COALESCE($3,notes),"updatedAt"=NOW() WHERE id=$1 RETURNING *',
      [req.params.id, b.status||null, b.notes||null]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, grant: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await req.db.query("DELETE FROM grants WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
