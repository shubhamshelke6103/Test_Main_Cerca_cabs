const jwt = require('jsonwebtoken');
const Admin = require('../Models/User/admin.model.js');
const AppError = require('./errors/AppError');

const authenticateAdmin = async (req, res, next) => {
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const admin = await Admin.findById(decoded.id);
    if (!admin || admin.isActive === false) {
      return next(
        new AppError('Admin access denied', 403, {
          code: 'ADMIN_ACCESS_DENIED',
        })
      );
    }

    req.adminId = admin._id;
    req.admin = admin;
    req.adminRole = admin.role;
    next();
  } catch (error) {
    return next(
      new AppError('Invalid or expired token', 401, {
        code: 'INVALID_OR_EXPIRED_TOKEN',
      })
    );
  }
};

const requireRole = (roles = []) => {
  const roleList = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!roleList.length || roleList.includes(req.adminRole)) {
      return next();
    }
    return next(
      new AppError('Insufficient permissions', 403, {
        code: 'INSUFFICIENT_PERMISSIONS',
      })
    );
  };
};

module.exports = { authenticateAdmin, requireRole };

