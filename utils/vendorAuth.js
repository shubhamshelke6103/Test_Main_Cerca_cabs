const jwt = require('jsonwebtoken');
const AppError = require('./errors/AppError');

/**
 * Verifies JWT for vendor routes. Expects Authorization: Bearer <token>.
 * Attaches req.user = { id: vendorId, role: 'vendor' }.
 * Use for all vendor routes except POST /register and POST /login.
 */
const authenticateVendor = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return next(
        new AppError('Missing or invalid authorization header', 401, {
          code: 'AUTH_HEADER_INVALID',
        })
      );
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.ACCESS_SECRET);

    if (decoded.role !== 'vendor') {
      return next(
        new AppError('Vendor access only', 403, {
          code: 'VENDOR_ACCESS_ONLY',
        })
      );
    }

    req.user = { id: decoded.id, role: 'vendor' };
    next();
  } catch (error) {
    return next(
      new AppError('Invalid or expired token', 401, {
        code: 'INVALID_OR_EXPIRED_TOKEN',
      })
    );
  }
};


module.exports = { authenticateVendor };
