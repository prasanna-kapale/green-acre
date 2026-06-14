const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  let token = null;

  // Accept from Authorization header (Bearer) OR httpOnly cookie
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies && req.cookies.ga_token) {
    token = req.cookies.ga_token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }
      return res.status(403).json({ error: 'Invalid token.' });
    }
    req.manager = decoded;
    next();
  });
}

module.exports = { authenticateToken };
