/**
 * WhatsApp notification service
 * Uses Twilio if configured, otherwise returns manual deep-link fallback
 */

async function sendWhatsAppMessage(to, message) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = process.env;

  // If Twilio not configured, log and return fallback
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    console.log('[WhatsApp Fallback] Would send to:', to);
    console.log('[WhatsApp Fallback] Message:', message);
    return { success: false, fallback: true, deepLink: buildDeepLink(to, message) };
  }

  try {
    // Dynamic require so server starts without twilio if not installed
    const twilio = require('twilio');
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

    const msg = await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: toFormatted,
      body: message,
    });

    console.log('[WhatsApp] Sent. SID:', msg.sid);
    return { success: true, sid: msg.sid };
  } catch (err) {
    console.error('[WhatsApp] Send failed:', err.message);
    return { success: false, error: err.message, deepLink: buildDeepLink(to, message) };
  }
}

function buildDeepLink(phone, message) {
  const cleanPhone = phone.replace(/\D/g, '');
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${cleanPhone}?text=${encoded}`;
}

module.exports = { sendWhatsAppMessage, buildDeepLink };
