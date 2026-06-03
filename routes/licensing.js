// routes/licensing.js
// RRN Backend — Platform Licensing Route
// Endpoints:
//   GET  /api/licensing/partners        — list all licensing partners/leads
//   POST /api/licensing/partners        — add a new licensing lead
//   GET  /api/licensing/revenue         — revenue summary across all active licenses
//   PUT  /api/licensing/:id             — update a licensing record
//
// Install: in server.js add:
//   const licensingRouter = require('./routes/licensing');
//   app.use('/api/licensing', requireAuth, licensingRouter);

const express = require('express');
const router  = express.Router();

// ---------------------------------------------------------------------------
// GET /api/licensing/partners
// Returns all licensing leads/partners
// ---------------------------------------------------------------------------
router.get('/partners', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT
         id, org_name, contact, email, phone, org_type,
         member_count, source, stage, notes,
         monthly_fee, contract_start, contract_end,
         created_at, updated_at
       FROM rrn_licensing_partners
       ORDER BY created_at DESC`
    );

    res.json(rows.map(function(r) {
      return {
        id:            r.id,
        orgName:       r.org_name,
        contact:       r.contact,
        email:         r.email,
        phone:         r.phone,
        orgType:       r.org_type,
        members:       r.member_count,
        source:        r.source,
        stage:         r.stage,
        notes:         r.notes,
        monthlyFee:    r.monthly_fee,
        contractStart: r.contract_start,
        contractEnd:   r.contract_end,
        createdAt:     r.created_at,
        updatedAt:     r.updated_at,
      };
    }));
  } catch (err) {
    console.error('[RRN] GET /licensing/partners error:', err.message);
    res.status(500).json({ error: 'Failed to load licensing partners', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/licensing/partners
// Add a new licensing lead
// ---------------------------------------------------------------------------
router.post('/partners', async (req, res) => {
  try {
    const b = req.body || {};
    const createdBy = (req.user && req.user.id) || null;

    const { rows } = await req.db.query(
      `INSERT INTO rrn_licensing_partners
         (org_name, contact, email, phone, org_type, member_count,
          source, stage, notes, monthly_fee, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        b.orgName  || b.org_name  || 'Unknown Org',
        b.contact  || null,
        b.email    || null,
        b.phone    || null,
        b.orgType  || b.org_type  || null,
        b.members  || b.member_count || 0,
        b.source   || null,
        b.stage    || 'inquiry',
        b.notes    || null,
        b.monthlyFee || b.monthly_fee || null,
        createdBy,
      ]
    );

    const r = rows[0];

    // Audit log
    try {
      await req.db.query(
        `INSERT INTO audit_log (action, table_name, record_id, performed_by, details)
         VALUES ('create','rrn_licensing_partners',$1,$2,$3)`,
        [r.id, createdBy, JSON.stringify({ orgName: r.org_name, stage: r.stage })]
      );
    } catch(auditErr) {
      console.warn('[RRN] Licensing audit log failed (non-fatal):', auditErr.message);
    }

    res.status(201).json({
      id:        r.id,
      orgName:   r.org_name,
      contact:   r.contact,
      email:     r.email,
      stage:     r.stage,
      notes:     r.notes,
      createdAt: r.created_at,
    });
  } catch (err) {
    console.error('[RRN] POST /licensing/partners error:', err.message);
    res.status(500).json({ error: 'Failed to add licensing partner', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/licensing/revenue
// Returns MRR summary across all active licensing partners
// ---------------------------------------------------------------------------
router.get('/revenue', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT
         COUNT(*)                                    AS total_partners,
         COUNT(*) FILTER (WHERE stage = 'active')   AS active_count,
         COALESCE(SUM(monthly_fee) FILTER (WHERE stage = 'active'), 0) AS mrr,
         COALESCE(SUM(monthly_fee) FILTER (WHERE stage = 'active'), 0) * 12 AS arr
       FROM rrn_licensing_partners`
    );

    const r = rows[0];
    res.json({
      totalPartners: parseInt(r.total_partners, 10),
      activeCount:   parseInt(r.active_count,   10),
      mrr:           parseFloat(r.mrr),
      arr:           parseFloat(r.arr),
    });
  } catch (err) {
    console.error('[RRN] GET /licensing/revenue error:', err.message);
    res.status(500).json({ error: 'Failed to load licensing revenue', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/licensing/:id
// Update a licensing record (stage, monthly_fee, notes, contract dates)
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    const { rows } = await req.db.query(
      `UPDATE rrn_licensing_partners
       SET
         stage          = COALESCE($2, stage),
         monthly_fee    = COALESCE($3, monthly_fee),
         notes          = COALESCE($4, notes),
         contract_start = COALESCE($5, contract_start),
         contract_end   = COALESCE($6, contract_end),
         updated_at     = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        b.stage         || null,
        b.monthlyFee    || b.monthly_fee    || null,
        b.notes         || null,
        b.contractStart || b.contract_start || null,
        b.contractEnd   || b.contract_end   || null,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Licensing record not found' });
    }

    res.json({ ok: true, partner: rows[0] });
  } catch (err) {
    console.error('[RRN] PUT /licensing/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update licensing record', detail: err.message });
  }
});

module.exports = router;
