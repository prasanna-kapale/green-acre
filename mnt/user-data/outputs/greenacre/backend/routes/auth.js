const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool    = require('../config/db');
const { auditLog } = require('../utils/helpers');

const router = express.Router();

// Rate limit login — 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 5,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, password_hash, display_name FROM managers WHERE username = $1',
      [username.trim().toLowerCase()]
    );

    if (result.rowCount === 0) {
      // Constant-time response to prevent username enumeration
      await bcrypt.compare(password, '$2a$12$invalidhashpadding000000000000000000000000000000000000000');
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const manager = result.rows[0];
    const valid = await bcrypt.compare(password, manager.password_hash);

    if (!valid) {
      await auditLog(null, 'LOGIN_FAILED', 'manager', manager.id, { username }, req.ip);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // Update last login timestamp
    await pool.query('UPDATE managers SET last_login = NOW() WHERE id = $1', [manager.id]);

    const token = jwt.sign(
      { id: manager.id, username: manager.username, displayName: manager.display_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Set httpOnly cookie as primary session mechanism
    res.cookie('ga_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    });

    await auditLog(manager.id, 'LOGIN_SUCCESS', 'manager', manager.id, {}, req.ip);

    res.json({
      success: true,
      token,
      manager: {
        id: manager.id,
        username: manager.username,
        displayName: manager.display_name,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('ga_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
  res.json({ success: true, message: 'Logged out successfully.' });
});

// GET /api/auth/verify — check if current token is still valid
router.get('/verify', require('../middleware/auth').authenticateToken, (req, res) => {
  res.json({ valid: true, manager: req.manager });
});

module.exports = router;
