const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'inv-secret-key-please-change-in-production-2024';

function authMiddleware(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized — please log in' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session — please log in again' });
  }
}

module.exports = { authMiddleware, JWT_SECRET };
