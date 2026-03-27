const jwt = require('jsonwebtoken');
const Driver = require('../Models/Driver/driver.model');

const authenticateDriver = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const driver = await Driver.findById(decoded.id).select('_id isActive');

    if (!driver) {
      return res.status(403).json({ message: 'Driver access denied' });
    }

    req.driver = driver;
    req.driverId = String(driver._id);
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = { authenticateDriver };
