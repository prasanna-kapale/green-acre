const express  = require('express');
const pool     = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const { auditLog, buildGuestWhatsAppMessage } = require('../utils/helpers');
const { sendWhatsAppMessage, buildDeepLink } = require('../utils/whatsapp');

const router = express.Router();

// All admin routes require authentication
router.use(authenticateToken);

// ── GET /api/admin/stats ─────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const nextMonth  = new Date(now.getFullYear(), now.getMonth()+1, 1).toISOString().split('T')[0];

    const [revenueRes, pendingRes, confirmedRes, bookedDaysRes, recentRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(rate_applied),0) as total
         FROM bookings WHERE status='CONFIRMED' AND booking_date >= $1 AND booking_date < $2`,
        [monthStart, nextMonth]
      ),
      pool.query(`SELECT COUNT(*) as count FROM bookings WHERE status='PENDING'`),
      pool.query(
        `SELECT COUNT(*) as count FROM bookings WHERE status='CONFIRMED' AND booking_date >= $1`,
        [monthStart]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT booking_date) as count FROM bookings
         WHERE status IN ('PENDING','CONFIRMED') AND booking_date >= $1 AND booking_date < $2`,
        [monthStart, nextMonth]
      ),
      pool.query(
        `SELECT id, guest_name, guest_phone, booking_date, slot, rate_applied, status, created_at
         FROM bookings ORDER BY created_at DESC LIMIT 5`
      ),
    ]);

    // Revenue trend vs last month
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().split('T')[0];
    const lastMonthEnd   = monthStart;
    const lastRevenueRes = await pool.query(
      `SELECT COALESCE(SUM(rate_applied),0) as total FROM bookings
       WHERE status='CONFIRMED' AND booking_date >= $1 AND booking_date < $2`,
      [lastMonthStart, lastMonthEnd]
    );

    const thisRevenue = Number(revenueRes.rows[0].total);
    const lastRevenue = Number(lastRevenueRes.rows[0].total);
    const revenueTrend = lastRevenue > 0
      ? Math.round(((thisRevenue - lastRevenue) / lastRevenue) * 100)
      : null;

    res.json({
      monthlyRevenue:  thisRevenue,
      revenueTrend,
      pendingCount:    Number(pendingRes.rows[0].count),
      confirmedCount:  Number(confirmedRes.rows[0].count),
      bookedDaysCount: Number(bookedDaysRes.rows[0].count),
      recentBookings:  recentRes.rows.map(b => ({
        ...b,
        bookingDate: b.booking_date.toISOString().split('T')[0],
        rateApplied: Number(b.rate_applied),
      })),
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard stats.' });
  }
});

// ── GET /api/admin/bookings ───────────────────────────────────
router.get('/bookings', async (req, res) => {
  const { status, month, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = [];
    let params = [];
    let idx = 1;

    if (status && status !== 'ALL') {
      where.push(`b.status = $${idx++}`);
      params.push(status);
    }
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const first = `${y}-${String(m).padStart(2,'0')}-01`;
      const last  = new Date(y, m, 0).toISOString().split('T')[0];
      where.push(`b.booking_date >= $${idx++} AND b.booking_date <= $${idx++}`);
      params.push(first, last);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM bookings b ${whereClause}`,
      params
    );

    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT id, guest_name, guest_phone, guest_email, guest_count,
              occasion, notes, booking_date, slot, rate_applied, rate_label,
              status, created_at, confirmed_at, manager_notes
       FROM bookings b ${whereClause}
       ORDER BY
         CASE status WHEN 'PENDING' THEN 1 WHEN 'CONFIRMED' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      params
    );

    // Build WhatsApp deep links for each booking
    const managerPhone = process.env.MANAGER_WHATSAPP;
    const rows = result.rows.map(b => {
      const phone = b.guest_phone.replace(/\D/g,'');
      const waLink = `https://wa.me/${phone}`;
      return {
        ...b,
        bookingDate: b.booking_date.toISOString().split('T')[0],
        rateApplied: Number(b.rate_applied),
        whatsappLink: waLink,
      };
    });

    res.json({
      bookings: rows,
      total: Number(countRes.rows[0].total),
      page: parseInt(page),
      pages: Math.ceil(Number(countRes.rows[0].total) / parseInt(limit)),
    });
  } catch (err) {
    console.error('Admin bookings error:', err.message);
    res.status(500).json({ error: 'Failed to load bookings.' });
  }
});

// ── PATCH /api/admin/bookings/:id/confirm ────────────────────
router.patch('/bookings/:id/confirm', async (req, res) => {
  const { id } = req.params;
  const { managerNotes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE bookings SET status='CONFIRMED', confirmed_at=NOW(), manager_notes=$1
       WHERE id=$2 AND status='PENDING' RETURNING *`,
      [managerNotes || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found or not in PENDING status.' });
    }

    const booking = result.rows[0];

    // Status history
    await pool.query(
      `INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, notes)
       VALUES ($1,'PENDING','CONFIRMED',$2,$3)`,
      [id, req.manager.id, managerNotes || 'Confirmed by manager']
    );

    await auditLog(req.manager.id, 'BOOKING_CONFIRMED', 'booking', id, {}, req.ip);

    // Send WhatsApp to guest
    const guestMsg = buildGuestWhatsAppMessage({
      id, guest_name: booking.guest_name,
      booking_date: booking.booking_date.toISOString().split('T')[0],
      slot: booking.slot, rate_applied: Number(booking.rate_applied)
    });
    const waResult = await sendWhatsAppMessage(booking.guest_phone, guestMsg);

    res.json({
      success: true,
      booking: { ...booking, bookingDate: booking.booking_date.toISOString().split('T')[0] },
      whatsappSent: waResult.success,
      whatsappDeepLink: waResult.deepLink || buildDeepLink(booking.guest_phone, guestMsg),
    });
  } catch (err) {
    console.error('Confirm booking error:', err.message);
    res.status(500).json({ error: 'Failed to confirm booking.' });
  }
});

// ── PATCH /api/admin/bookings/:id/release ────────────────────
router.patch('/bookings/:id/release', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const result = await pool.query(
      `UPDATE bookings SET status='RELEASED', released_at=NOW(), manager_notes=$1
       WHERE id=$2 AND status IN ('PENDING','CONFIRMED') RETURNING *`,
      [reason || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found or already released/cancelled.' });
    }

    const booking = result.rows[0];
    await pool.query(
      `INSERT INTO booking_status_history (booking_id, old_status, new_status, changed_by, notes)
       VALUES ($1,$2,'RELEASED',$3,$4)`,
      [id, booking.status, req.manager.id, reason || 'Released by manager']
    );

    await auditLog(req.manager.id, 'BOOKING_RELEASED', 'booking', id, { reason }, req.ip);

    res.json({ success: true, bookingId: id, status: 'RELEASED' });
  } catch (err) {
    console.error('Release booking error:', err.message);
    res.status(500).json({ error: 'Failed to release booking.' });
  }
});

// ── GET /api/admin/pricing-rules?month=YYYY-MM ───────────────
router.get('/pricing-rules', async (req, res) => {
  const { month } = req.query;

  try {
    let result;
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const first = `${y}-${String(m).padStart(2,'0')}-01`;
      const last  = new Date(y, m, 0).toISOString().split('T')[0];
      result = await pool.query(
        `SELECT * FROM pricing_rules WHERE target_date >= $1 AND target_date <= $2 ORDER BY target_date`,
        [first, last]
      );
    } else {
      result = await pool.query('SELECT * FROM pricing_rules ORDER BY target_date');
    }

    res.json({
      rules: result.rows.map(r => ({
        ...r,
        targetDate: r.target_date.toISOString().split('T')[0],
        daySlotRate: r.day_slot_rate ? Number(r.day_slot_rate) : null,
        nightSlotRate: r.night_slot_rate ? Number(r.night_slot_rate) : null,
      }))
    });
  } catch (err) {
    console.error('Pricing rules admin error:', err.message);
    res.status(500).json({ error: 'Failed to load pricing rules.' });
  }
});

// ── POST /api/admin/pricing-rules (upsert) ───────────────────
router.post('/pricing-rules', async (req, res) => {
  const { targetDate, labelName, daySlotRate, nightSlotRate, isClosed, notes } = req.body;

  if (!targetDate) return res.status(400).json({ error: 'targetDate is required.' });

  try {
    const result = await pool.query(
      `INSERT INTO pricing_rules (target_date, label_name, day_slot_rate, night_slot_rate, is_closed, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (target_date) DO UPDATE SET
         label_name     = EXCLUDED.label_name,
         day_slot_rate  = EXCLUDED.day_slot_rate,
         night_slot_rate= EXCLUDED.night_slot_rate,
         is_closed      = EXCLUDED.is_closed,
         notes          = EXCLUDED.notes,
         updated_at     = NOW()
       RETURNING *`,
      [targetDate, labelName || 'NORMAL', daySlotRate || null, nightSlotRate || null,
       isClosed || false, notes || null]
    );

    await auditLog(req.manager.id, 'PRICING_RULE_UPSERTED', 'pricing_rule', targetDate, req.body, req.ip);

    const r = result.rows[0];
    res.json({
      success: true,
      rule: {
        ...r,
        targetDate: r.target_date.toISOString().split('T')[0],
        daySlotRate: r.day_slot_rate ? Number(r.day_slot_rate) : null,
        nightSlotRate: r.night_slot_rate ? Number(r.night_slot_rate) : null,
      }
    });
  } catch (err) {
    console.error('Pricing rule upsert error:', err.message);
    res.status(500).json({ error: 'Failed to save pricing rule.' });
  }
});

// ── PUT /api/admin/pricing-rules/:id ─────────────────────────
router.put('/pricing-rules/:id', async (req, res) => {
  const { id } = req.params;
  const { labelName, daySlotRate, nightSlotRate, isClosed, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE pricing_rules SET
         label_name      = COALESCE($1, label_name),
         day_slot_rate   = COALESCE($2, day_slot_rate),
         night_slot_rate = COALESCE($3, night_slot_rate),
         is_closed       = COALESCE($4, is_closed),
         notes           = COALESCE($5, notes),
         updated_at      = NOW()
       WHERE id = $6 RETURNING *`,
      [labelName, daySlotRate || null, nightSlotRate || null, isClosed, notes, id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Pricing rule not found.' });

    await auditLog(req.manager.id, 'PRICING_RULE_UPDATED', 'pricing_rule', id, req.body, req.ip);

    const r = result.rows[0];
    res.json({
      success: true,
      rule: {
        ...r,
        targetDate: r.target_date.toISOString().split('T')[0],
        daySlotRate: r.day_slot_rate ? Number(r.day_slot_rate) : null,
        nightSlotRate: r.night_slot_rate ? Number(r.night_slot_rate) : null,
      }
    });
  } catch (err) {
    console.error('Pricing rule update error:', err.message);
    res.status(500).json({ error: 'Failed to update pricing rule.' });
  }
});

// ── DELETE /api/admin/pricing-rules/:id ──────────────────────
router.delete('/pricing-rules/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM pricing_rules WHERE id=$1 RETURNING id, target_date', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pricing rule not found.' });

    await auditLog(req.manager.id, 'PRICING_RULE_DELETED', 'pricing_rule', id, {}, req.ip);
    res.json({ success: true, deleted: id });
  } catch (err) {
    console.error('Delete pricing rule error:', err.message);
    res.status(500).json({ error: 'Failed to delete pricing rule.' });
  }
});

// ── GET /api/admin/default-rates ─────────────────────────────
router.get('/default-rates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM default_rates ORDER BY day_type');
    res.json({ rates: result.rows.map(r => ({ ...r, daySlotRate: Number(r.day_slot_rate), nightSlotRate: Number(r.night_slot_rate) })) });
  } catch (err) {
    console.error('Default rates error:', err.message);
    res.status(500).json({ error: 'Failed to load default rates.' });
  }
});

// ── PUT /api/admin/default-rates/:id ─────────────────────────
router.put('/default-rates/:id', async (req, res) => {
  const { id } = req.params;
  const { daySlotRate, nightSlotRate } = req.body;

  if (!daySlotRate && !nightSlotRate) return res.status(400).json({ error: 'At least one rate is required.' });

  try {
    const result = await pool.query(
      `UPDATE default_rates SET
         day_slot_rate   = COALESCE($1, day_slot_rate),
         night_slot_rate = COALESCE($2, night_slot_rate),
         updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [daySlotRate || null, nightSlotRate || null, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Default rate not found.' });

    await auditLog(req.manager.id, 'DEFAULT_RATE_UPDATED', 'default_rate', id, req.body, req.ip);

    const r = result.rows[0];
    res.json({ success: true, rate: { ...r, daySlotRate: Number(r.day_slot_rate), nightSlotRate: Number(r.night_slot_rate) } });
  } catch (err) {
    console.error('Default rate update error:', err.message);
    res.status(500).json({ error: 'Failed to update default rate.' });
  }
});

// ── GET /api/admin/policy ─────────────────────────────────────
router.get('/policy', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM policy_content ORDER BY id');
    res.json({ policies: result.rows });
  } catch (err) {
    console.error('Admin policy error:', err.message);
    res.status(500).json({ error: 'Failed to load policies.' });
  }
});

// ── PUT /api/admin/policy/:sectionKey ────────────────────────
router.put('/policy/:sectionKey', async (req, res) => {
  const { sectionKey } = req.params;
  const { title, contentText } = req.body;

  if (!contentText) return res.status(400).json({ error: 'contentText is required.' });

  try {
    const result = await pool.query(
      `UPDATE policy_content SET
         title = COALESCE($1, title),
         content_text = $2,
         updated_at = NOW()
       WHERE section_key = $3 RETURNING *`,
      [title, contentText, sectionKey]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Policy section not found.' });

    await auditLog(req.manager.id, 'POLICY_UPDATED', 'policy_content', sectionKey, {}, req.ip);
    res.json({ success: true, policy: result.rows[0] });
  } catch (err) {
    console.error('Policy update error:', err.message);
    res.status(500).json({ error: 'Failed to update policy.' });
  }
});

// ── GET /api/admin/blackouts ──────────────────────────────────
router.get('/blackouts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM blackout_dates ORDER BY date_from');
    res.json({
      blackouts: result.rows.map(r => ({
        ...r,
        dateFrom: r.date_from.toISOString().split('T')[0],
        dateTo:   r.date_to.toISOString().split('T')[0],
      }))
    });
  } catch (err) {
    console.error('Blackouts error:', err.message);
    res.status(500).json({ error: 'Failed to load blackout dates.' });
  }
});

// ── POST /api/admin/blackouts ─────────────────────────────────
router.post('/blackouts', async (req, res) => {
  const { dateFrom, dateTo, reason } = req.body;
  if (!dateFrom || !dateTo || !reason) return res.status(400).json({ error: 'dateFrom, dateTo and reason are required.' });
  if (dateTo < dateFrom) return res.status(400).json({ error: 'dateTo must be >= dateFrom.' });

  try {
    const result = await pool.query(
      `INSERT INTO blackout_dates (date_from, date_to, reason, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [dateFrom, dateTo, reason.trim(), req.manager.id]
    );

    await auditLog(req.manager.id, 'BLACKOUT_CREATED', 'blackout', result.rows[0].id, req.body, req.ip);

    const r = result.rows[0];
    res.status(201).json({
      success: true,
      blackout: { ...r, dateFrom: r.date_from.toISOString().split('T')[0], dateTo: r.date_to.toISOString().split('T')[0] }
    });
  } catch (err) {
    console.error('Blackout create error:', err.message);
    res.status(500).json({ error: 'Failed to create blackout.' });
  }
});

// ── DELETE /api/admin/blackouts/:id ──────────────────────────
router.delete('/blackouts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM blackout_dates WHERE id=$1 RETURNING id', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Blackout not found.' });

    await auditLog(req.manager.id, 'BLACKOUT_DELETED', 'blackout', id, {}, req.ip);
    res.json({ success: true, deleted: id });
  } catch (err) {
    console.error('Delete blackout error:', err.message);
    res.status(500).json({ error: 'Failed to delete blackout.' });
  }
});

// ── GET /api/admin/reviews ────────────────────────────────────
router.get('/reviews', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    res.json({ reviews: result.rows });
  } catch (err) {
    console.error('Admin reviews error:', err.message);
    res.status(500).json({ error: 'Failed to load reviews.' });
  }
});

// ── PATCH /api/admin/reviews/:id ─────────────────────────────
router.patch('/reviews/:id', async (req, res) => {
  const { id } = req.params;
  const { isPublished } = req.body;

  try {
    const result = await pool.query(
      'UPDATE reviews SET is_published=$1 WHERE id=$2 RETURNING *',
      [isPublished, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Review not found.' });
    res.json({ success: true, review: result.rows[0] });
  } catch (err) {
    console.error('Review update error:', err.message);
    res.status(500).json({ error: 'Failed to update review.' });
  }
});

// ── GET /api/admin/content ────────────────────────────────────
router.get('/content', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM property_content ORDER BY key');
    const content = {};
    result.rows.forEach(r => { content[r.key] = r.value; });
    res.json({ content });
  } catch (err) {
    console.error('Content error:', err.message);
    res.status(500).json({ error: 'Failed to load content.' });
  }
});

// ── PATCH /api/admin/content ──────────────────────────────────
router.patch('/content', async (req, res) => {
  const updates = req.body;
  if (!updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updates provided.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(updates)) {
      await client.query(
        `INSERT INTO property_content (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [key, String(value)]
      );
    }
    await client.query('COMMIT');
    await auditLog(req.manager.id, 'CONTENT_UPDATED', 'property_content', null, updates, req.ip);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Content update error:', err.message);
    res.status(500).json({ error: 'Failed to update content.' });
  } finally {
    client.release();
  }
});

// ── GET /api/admin/audit-logs ─────────────────────────────────
router.get('/audit-logs', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const result = await pool.query(
      `SELECT al.*, m.display_name as manager_name
       FROM audit_logs al
       LEFT JOIN managers m ON al.manager_id = m.id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );
    res.json({ logs: result.rows });
  } catch (err) {
    console.error('Audit logs error:', err.message);
    res.status(500).json({ error: 'Failed to load audit logs.' });
  }
});

// ── POST /api/admin/change-password ──────────────────────────
router.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  try {
    const result = await pool.query('SELECT password_hash FROM managers WHERE id=$1', [req.manager.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Manager not found.' });

    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE managers SET password_hash=$1 WHERE id=$2', [hash, req.manager.id]);
    await auditLog(req.manager.id, 'PASSWORD_CHANGED', 'manager', req.manager.id, {}, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

module.exports = router;
