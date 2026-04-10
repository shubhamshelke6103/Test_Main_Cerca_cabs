const jwt = require('jsonwebtoken');
const Driver = require('../Models/Driver/driver.model');
const AppError = require('./errors/AppError');
const LEGACY_JWT_SECRET =
  "@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%";

const authenticateDriver = async (req, res, next) => {
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || LEGACY_JWT_SECRET);
    const driver = await Driver.findById(decoded.id).select('_id isActive');

    if (!driver) {
      return next(
        new AppError('Driver access denied', 403, {
          code: 'DRIVER_ACCESS_DENIED',
        })
      );
    }

    req.driver = driver;
    req.driverId = String(driver._id);
    return next();
  } catch (error) {
    return next(
      new AppError('Invalid or expired token', 401, {
        code: 'INVALID_OR_EXPIRED_TOKEN',
      })
    );
  }
};

module.exports = { authenticateDriver };
