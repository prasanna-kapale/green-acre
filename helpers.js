const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

/**
 * Generate a unique booking reference: GRN-YYYY-NNNN
 */
async function generateBookingRef(year) {
  const y = year || new Date().getFullYear();
  let ref, exists;
  let attempts = 0;

  do {
    const rand = Math.floor(1000 + Math.random() * 9000);
    ref = `GRN-${y}-${rand}`;
    const result = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [ref]);
    exists = result.rowCount > 0;
    attempts++;
    if (attempts > 20) throw new Error('Unable to generate unique booking reference.');
  } while (exists);

  return ref;
}

/**
 * Determine if a given date string (YYYY-MM-DD) is a weekend (Fri/Sat/Sun)
 */
function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay(); // 0=Sun, 5=Fri, 6=Sat
  return dow === 0 || dow === 5 || dow === 6;
}

/**
 * Format Indian Rupees
 */
function formatINR(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

/**
 * Build WhatsApp message for new booking (manager notification)
 */
function buildManagerWhatsAppMessage(booking) {
  const slotTime = booking.slot === 'day' ? '8:00 AM – 8:00 PM' : '8:00 PM – 8:00 AM';
  return `🏡 *New Booking Request — The Green Acre*\n\n` +
    `📋 Ref: *${booking.id}*\n` +
    `👤 Guest: ${booking.guest_name}\n` +
    `📱 WhatsApp: ${booking.guest_phone}\n` +
    `📅 Date: ${booking.booking_date}\n` +
    `⏰ Slot: ${booking.slot === 'day' ? 'Day' : 'Night'} (${slotTime})\n` +
    `👥 Guests: ${booking.guest_count}\n` +
    `🎉 Occasion: ${booking.occasion || 'Not specified'}\n` +
    `💰 Rate: ${formatINR(booking.rate_applied)} (${booking.rate_label})\n\n` +
    `Reply to confirm or release this booking in the admin panel.`;
}

/**
 * Build WhatsApp message for guest confirmation
 */
function buildGuestWhatsAppMessage(booking) {
  const slotTime = booking.slot === 'day' ? '8:00 AM – 8:00 PM' : '8:00 PM – 8:00 AM';
  return `✅ *Booking Confirmed — The Green Acre*\n\n` +
    `Hello ${booking.guest_name},\n\n` +
    `Your booking has been confirmed!\n\n` +
    `📋 Ref: *${booking.id}*\n` +
    `📅 Date: ${booking.booking_date}\n` +
    `⏰ Slot: ${booking.slot === 'day' ? 'Day' : 'Night'} (${slotTime})\n` +
    `💰 Amount: ${formatINR(booking.rate_applied)}\n\n` +
    `We look forward to hosting you!\n` +
    `📍 The Green Acre, Pune, Maharashtra`;
}

/**
 * Log an audit entry
 */
async function auditLog(managerId, action, entityType, entityId, details, ip) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (manager_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [managerId || null, action, entityType || null, entityId || null,
       details ? JSON.stringify(details) : null, ip || null]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = {
  generateBookingRef,
  isWeekend,
  formatINR,
  buildManagerWhatsAppMessage,
  buildGuestWhatsAppMessage,
  auditLog,
};
