const express = require('express');
const router = express.Router();
const {
  getDriverEarnings,
  getPaymentHistory,
  getCashOwedSummary,
} = require('../../Controllers/Driver/earnings.controller');

/**
 * @route   GET /api/drivers/:driverId/earnings/payments
 * @desc    Get driver payment history
 */
router.get('/:driverId/earnings/payments', getPaymentHistory);

/**
 * @route   GET /api/drivers/:driverId/earnings/cash-owed-summary
 */
router.get('/:driverId/earnings/cash-owed-summary', getCashOwedSummary);

/**
 * @route   GET /api/drivers/:driverId/earnings
 * @desc    Get driver earnings dashboard
 */
router.get('/:driverId/earnings', getDriverEarnings);

module.exports = router;

