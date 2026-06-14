const express = require('express');
const pool    = require('../config/db');
const { generateBookingRef, isWeekend, buildManagerWhatsAppMessage } = require('../utils/helpers');
const { sendWhatsAppMessage } = require('../utils/whatsapp');

const router = express.Router();

// ── GET /api/calendar?month=YYYY-MM ──────────────────────────
// Returns calendar data for a given month: each day's status + rates
router.get('/calendar', async (req, res) => {
  const { month } = req.query;

  // Validate month param
  const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!month || !monthRegex.test(month)) {
    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    req.query.month = defaultMonth;
  }

  const [year, mon] = (req.query.month || month).split('-').map(Number);

  try {
    // Get default rates
    const defaultRatesRes = await pool.query('SELECT * FROM default_rates');
    const defaults = {};
    defaultRatesRes.rows.forEach(r => { defaults[r.day_type] = r; });

    // Get all pricing rules for this month
    const firstDay = `${year}-${String(mon).padStart(2,'0')}-01`;
    const lastDay  = new Date(year, mon, 0).toISOString().split('T')[0];

    const rulesRes = await pool.query(
      `SELECT * FROM pricing_rules WHERE target_date >= $1 AND target_date <= $2`,
      [firstDay, lastDay]
    );
    const rules = {};
    rulesRes.rows.forEach(r => { rules[r.target_date.toISOString().split('T')[0]] = r; });

    // Get all bookings for this month (PENDING or CONFIRMED only)
    const bookingsRes = await pool.query(
      `SELECT booking_date, slot, status FROM bookings
       WHERE booking_date >= $1 AND booking_date <= $2
         AND status IN ('PENDING','CONFIRMED')`,
      [firstDay, lastDay]
    );
    const bookings = {};
    bookingsRes.rows.forEach(b => {
      const d = b.booking_date.toISOString().split('T')[0];
      if (!bookings[d]) bookings[d] = {};
      bookings[d][b.slot] = b.status;
    });

    // Get blackout dates overlapping this month
    const blackoutsRes = await pool.query(
      `SELECT date_from, date_to, reason FROM blackout_dates
       WHERE date_from <= $2 AND date_to >= $1`,
      [firstDay, lastDay]
    );
    const blackoutDates = new Set();
    blackoutsRes.rows.forEach(b => {
      const from = new Date(b.date_from);
      const to   = new Date(b.date_to);
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        blackoutDates.add(d.toISOString().split('T')[0]);
      }
    });

    // Build day-by-day calendar data
    const daysInMonth = new Date(year, mon, 0).getDate();
    const days = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const rule = rules[dateStr];
      const weekend = isWeekend(dateStr);
      const defaultKey = weekend ? 'weekend' : 'weekday';
      const defRates = defaults[defaultKey] || { day_slot_rate: 6000, night_slot_rate: 7000 };

      const isClosed = rule ? rule.is_closed : false;
      const isBlackout = blackoutDates.has(dateStr);

      const dayRate   = rule && rule.day_slot_rate   ? Number(rule.day_slot_rate)   : Number(defRates.day_slot_rate);
      const nightRate = rule && rule.night_slot_rate ? Number(rule.night_slot_rate) : Number(defRates.night_slot_rate);
      const label = rule ? rule.label_name : (weekend ? 'WEEKEND' : 'NORMAL');

      const daySlotStatus   = getSlotStatus(dateStr, 'day',   bookings, isClosed || isBlackout);
      const nightSlotStatus = getSlotStatus(dateStr, 'night', bookings, isClosed || isBlackout);

      days.push({
        date: dateStr,
        day: d,
        dayOfWeek: new Date(dateStr + 'T00:00:00').getDay(),
        isWeekend: weekend,
        isClosed: isClosed || isBlackout,
        label,
        daySlot:   { status: daySlotStatus,   rate: dayRate   },
        nightSlot: { status: nightSlotStatus, rate: nightRate },
      });
    }

    res.json({ month: req.query.month || month, year, monthNumber: mon, days, defaults });
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: 'Failed to load calendar.' });
  }
});

function getSlotStatus(dateStr, slot, bookings, isClosed) {
  if (isClosed) return 'closed';
  const today = new Date().toISOString().split('T')[0];
  if (dateStr < today) return 'past';
  const status = bookings[dateStr] && bookings[dateStr][slot];
  if (status === 'CONFIRMED') return 'booked';
  if (status === 'PENDING')   return 'pending';
  return 'available';
}

// ── GET /api/pricing-rules?date=YYYY-MM-DD ───────────────────
router.get('/pricing-rules', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date param required (YYYY-MM-DD).' });

  try {
    const defaultRatesRes = await pool.query('SELECT * FROM default_rates');
    const defaults = {};
    defaultRatesRes.rows.forEach(r => { defaults[r.day_type] = r; });

    const ruleRes = await pool.query('SELECT * FROM pricing_rules WHERE target_date = $1', [date]);
    const rule = ruleRes.rows[0];
    const weekend = isWeekend(date);
    const defKey = weekend ? 'weekend' : 'weekday';
    const def = defaults[defKey] || { day_slot_rate: 6000, night_slot_rate: 7000 };

    res.json({
      date,
      label: rule ? rule.label_name : (weekend ? 'WEEKEND' : 'NORMAL'),
      isClosed: rule ? rule.is_closed : false,
      dayRate:   rule && rule.day_slot_rate   ? Number(rule.day_slot_rate)   : Number(def.day_slot_rate),
      nightRate: rule && rule.night_slot_rate ? Number(rule.night_slot_rate) : Number(def.night_slot_rate),
    });
  } catch (err) {
    console.error('Pricing rules error:', err.message);
    res.status(500).json({ error: 'Failed to load pricing rules.' });
  }
});

// ── GET /api/policy ──────────────────────────────────────────
router.get('/policy', async (req, res) => {
  try {
    const result = await pool.query('SELECT section_key, title, content_text, updated_at FROM policy_content ORDER BY id');
    res.json({ policies: result.rows });
  } catch (err) {
    console.error('Policy error:', err.message);
    res.status(500).json({ error: 'Failed to load policies.' });
  }
});

// ── POST /api/bookings/request ───────────────────────────────
router.post('/bookings/request', async (req, res) => {
  const {
    guestName, guestPhone, guestEmail, guestCount,
    occasion, notes, bookingDate, slot, policyAgreed
  } = req.body;

  // Validation
  if (!guestName || !guestName.trim()) return res.status(400).json({ error: 'Guest name is required.' });
  if (!guestPhone || !guestPhone.trim()) return res.status(400).json({ error: 'WhatsApp number is required.' });
  if (!bookingDate) return res.status(400).json({ error: 'Booking date is required.' });
  if (!slot || !['day','night'].includes(slot)) return res.status(400).json({ error: 'Slot must be day or night.' });
  if (!policyAgreed) return res.status(400).json({ error: 'Policy agreement is required.' });
  if (!guestCount || parseInt(guestCount) < 1) return res.status(400).json({ error: 'Guest count must be at least 1.' });

  // Validate date is not in the past
  const today = new Date().toISOString().split('T')[0];
  if (bookingDate < today) return res.status(400).json({ error: 'Cannot book a past date.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if slot is available
    const conflictRes = await client.query(
      `SELECT id, status FROM bookings
       WHERE booking_date = $1 AND slot = $2 AND status IN ('PENDING','CONFIRMED')
       FOR UPDATE`,
      [bookingDate, slot]
    );
    if (conflictRes.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This slot is no longer available. Please select another date or slot.',
        conflictStatus: conflictRes.rows[0].status,
      });
    }

    // Check if date is closed/blackout
    const closedCheck = await client.query(
      `SELECT 1 FROM pricing_rules WHERE target_date = $1 AND is_closed = true`,
      [bookingDate]
    );
    const blackoutCheck = await client.query(
      `SELECT 1 FROM blackout_dates WHERE date_from <= $1 AND date_to >= $1`,
      [bookingDate]
    );
    if (closedCheck.rowCount > 0 || blackoutCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This date is not available for booking.' });
    }

    // Get rate
    const ruleRes = await client.query('SELECT * FROM pricing_rules WHERE target_date = $1', [bookingDate]);
    const rule = ruleRes.rows[0];
    const weekend = isWeekend(bookingDate);

    let rateApplied, rateLabel;
    if (rule && !rule.is_closed) {
      rateLabel = rule.label_name;
      rateApplied = slot === 'day' ? Number(rule.day_slot_rate) : Number(rule.night_slot_rate);
    }
    if (!rateApplied) {
      const defKey = weekend ? 'weekend' : 'weekday';
      const defRes = await client.query('SELECT * FROM default_rates WHERE day_type = $1', [defKey]);
      const def = defRes.rows[0] || { day_slot_rate: 6000, night_slot_rate: 7000 };
      rateApplied = slot === 'day' ? Number(def.day_slot_rate) : Number(def.night_slot_rate);
      rateLabel = weekend ? 'WEEKEND' : 'NORMAL';
    }

    // Generate reference
    const ref = await generateBookingRef(new Date(bookingDate).getFullYear());

    // Insert booking
    await client.query(
      `INSERT INTO bookings
         (id, guest_name, guest_phone, guest_email, guest_count, occasion, notes,
          booking_date, slot, rate_applied, rate_label, status, policy_agreed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',$12)`,
      [ref, guestName.trim(), guestPhone.trim(), guestEmail ? guestEmail.trim() : null,
       parseInt(guestCount), occasion ? occasion.trim() : null, notes ? notes.trim() : null,
       bookingDate, slot, rateApplied, rateLabel, policyAgreed]
    );

    // Insert status history
    await client.query(
      `INSERT INTO booking_status_history (booking_id, old_status, new_status, notes)
       VALUES ($1, NULL, 'PENDING', 'Booking request submitted by guest')`,
      [ref]
    );

    await client.query('COMMIT');

    // Send WhatsApp notification to manager (non-blocking)
    const managerPhone = process.env.MANAGER_WHATSAPP;
    if (managerPhone) {
      const booking = { id: ref, guest_name: guestName, guest_phone: guestPhone,
        booking_date: bookingDate, slot, guest_count: parseInt(guestCount),
        occasion, rate_applied: rateApplied, rate_label: rateLabel };
      const msg = buildManagerWhatsAppMessage(booking);
      sendWhatsAppMessage(managerPhone, msg).catch(e => console.error('WhatsApp send error:', e.message));
    }

    res.status(201).json({
      success: true,
      reference: ref,
      status: 'PENDING',
      bookingDate,
      slot,
      rateApplied,
      rateLabel,
      message: 'Booking request received. The manager will contact you shortly.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This slot was just booked. Please select another.' });
    }
    console.error('Booking error:', err.message);
    res.status(500).json({ error: 'Failed to create booking. Please try again.' });
  } finally {
    client.release();
  }
});

// ── GET /api/bookings/:refId ─────────────────────────────────
router.get('/bookings/:refId', async (req, res) => {
  const { refId } = req.params;

  // Validate reference format
  if (!/^GRN-\d{4}-\d{4}$/.test(refId)) {
    return res.status(400).json({ error: 'Invalid booking reference format.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, guest_name, guest_phone, guest_email, guest_count,
              occasion, booking_date, slot, rate_applied, rate_label,
              status, created_at, confirmed_at
       FROM bookings WHERE id = $1`,
      [refId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const b = result.rows[0];
    const slotTime = b.slot === 'day' ? '8:00 AM – 8:00 PM' : '8:00 PM – 8:00 AM';

    // Build WhatsApp deep link for manager contact
    const managerPhone = process.env.MANAGER_WHATSAPP;
    const waDeepLink = managerPhone
      ? `https://wa.me/${managerPhone.replace(/\D/g,'')}`
      : null;

    res.json({
      reference:   b.id,
      guestName:   b.guest_name,
      guestPhone:  b.guest_phone,
      guestEmail:  b.guest_email,
      guestCount:  b.guest_count,
      occasion:    b.occasion,
      bookingDate: b.booking_date.toISOString().split('T')[0],
      slot:        b.slot,
      slotTime,
      rateApplied: Number(b.rate_applied),
      rateLabel:   b.rate_label,
      status:      b.status,
      createdAt:   b.created_at,
      confirmedAt: b.confirmed_at,
      whatsappLink: waDeepLink,
    });
  } catch (err) {
    console.error('Booking lookup error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve booking.' });
  }
});

// ── GET /api/reviews ─────────────────────────────────────────
router.get('/reviews', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT guest_name, rating, review_text, occasion, created_at
       FROM reviews WHERE is_published = true
       ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ reviews: result.rows });
  } catch (err) {
    console.error('Reviews error:', err.message);
    res.status(500).json({ error: 'Failed to load reviews.' });
  }
});

module.exports = router;
