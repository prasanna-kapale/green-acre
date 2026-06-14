require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const cookieParser = require('cookie-parser');
const path        = require('path');

const publicRoutes = require('./routes/public');
const adminRoutes  = require('./routes/admin');
const authRoutes   = require('./routes/auth');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── SECURITY HEADERS ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // handled by frontend separately
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ─────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5500')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, server-to-server, same-origin)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy violation: origin not allowed.'));
    }
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── BODY PARSING ─────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(cookieParser());

// ── REQUEST LOGGING (minimal) ────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ── ROUTES ───────────────────────────────────────────────────
app.use('/api/auth',  authRoutes);
app.use('/api',       publicRoutes);
app.use('/api/admin', adminRoutes);

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'greenacre-api', timestamp: new Date().toISOString() });
});

// ── SERVE STATIC FRONTEND (production) ───────────────────────
// When frontend and backend are co-deployed (e.g. Railway with static folder)
if (process.env.SERVE_STATIC === 'true') {
  const staticDir = path.join(__dirname, '..', 'public');
  app.use(express.static(staticDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// ── ERROR HANDLER ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (err.message === 'CORS policy violation: origin not allowed.') {
    return res.status(403).json({ error: 'CORS error.' });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

// ── AUTO-RELEASE CRON (every 30 minutes) ─────────────────────
const AUTO_RELEASE_HOURS = parseInt(process.env.AUTO_RELEASE_HOURS) || 48;
const pool = require('./config/db');

setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE bookings SET status='RELEASED', released_at=NOW()
       WHERE status='PENDING'
         AND created_at < NOW() - INTERVAL '${AUTO_RELEASE_HOURS} hours'
       RETURNING id`
    );
    if (result.rowCount > 0) {
      console.log(`[Cron] Auto-released ${result.rowCount} expired pending booking(s).`);
      // Insert status history for each
      for (const row of result.rows) {
        await pool.query(
          `INSERT INTO booking_status_history (booking_id, old_status, new_status, notes)
           VALUES ($1,'PENDING','RELEASED','Auto-released after ${AUTO_RELEASE_HOURS}h')`,
          [row.id]
        );
      }
    }
  } catch (err) {
    console.error('[Cron] Auto-release error:', err.message);
  }
}, 30 * 60 * 1000); // every 30 minutes

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ The Green Acre API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   CORS origins: ${allowedOrigins.join(', ')}`);
});

module.exports = app;
