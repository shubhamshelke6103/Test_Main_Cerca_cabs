const express = require('express');
const { getDriverHeatmap, getDriverHotspotSnapshot } = require('../../Controllers/Driver/heatmap.controller');
const { authenticateDriver } = require('../../utils/driverAuth');

const router = express.Router();

router.use(authenticateDriver);
router.get('/:driverId/heatmap', (req, res, next) => {
  if (req.driverId !== req.params.driverId) {
    return res.status(403).json({ message: 'You are not authorized to access this driver heatmap' });
  }
  return next();
}, getDriverHeatmap);
router.get('/:driverId/hotspot-snapshot', (req, res, next) => {
  if (req.driverId !== req.params.driverId) {
    return res.status(403).json({ message: 'You are not authorized to access this driver hotspot snapshot' });
  }
  return next();
}, getDriverHotspotSnapshot);

module.exports = router;
