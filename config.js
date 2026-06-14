/* ============================================================
   THE GREEN ACRE — FRONTEND CONFIGURATION
   Update GA_API_BASE to point to your deployed backend URL.
   For local dev: http://localhost:3001/api
   For production: https://your-backend.railway.app/api
   ============================================================ */
window.GA_API_BASE = 'https://greenacre-api.railway.app/api';

/* Override for local development — remove in production */
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  window.GA_API_BASE = 'http://localhost:3001/api';
}
