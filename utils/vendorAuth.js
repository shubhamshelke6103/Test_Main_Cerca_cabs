const jwt = require('jsonwebtoken');

/**
 * Verifies JWT for vendor routes. Expects Authorization: Bearer <token>.
 * Attaches req.user = { id: vendorId, role: 'vendor' }.
 * Use for all vendor routes except POST /register and POST /login.
 */
const authenticateVendor = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.ACCESS_SECRET);

    if (decoded.role !== 'vendor') {
      return res.status(403).json({ message: 'Vendor access only' });
    }

    req.user = { id: decoded.id, role: 'vendor' };
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = { authenticateVendor };
