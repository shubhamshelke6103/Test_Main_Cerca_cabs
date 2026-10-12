const express = require('express');
const router = express.Router();
const {
  getDriverEarnings,
  getPaymentHistory,
  getCashOwedSummary,
  createPayCashDuesOrder,
  verifyPayCashDues,
} = require('../../Controllers/Driver/earnings.controller');

/**
 * @route   GET /drivers/:driverId/earnings/payments
 * @desc    Get driver payment history
 */
router.get('/:driverId/earnings/payments', getPaymentHistory);

/**
 * @route   GET /drivers/:driverId/earnings/cash-owed-summary
 * @desc    Get driver outstanding cash platform fees summary
 */
router.get('/:driverId/earnings/cash-owed-summary', getCashOwedSummary);

/**
 * @route   POST /drivers/:driverId/earnings/pay-cash-dues/create-order
 * @desc    Create Razorpay order for driver to pay outstanding cash platform fees
 */
router.post('/:driverId/earnings/pay-cash-dues/create-order', createPayCashDuesOrder);

/**
 * @route   POST /drivers/:driverId/earnings/pay-cash-dues/verify
 * @desc    Verify Razorpay payment and settle driver cash platform fee dues
 */
router.post('/:driverId/earnings/pay-cash-dues/verify', verifyPayCashDues);

/**
 * @route   GET /drivers/:driverId/earnings
 * @desc    Get driver earnings dashboard
 */
router.get('/:driverId/earnings', getDriverEarnings);

module.exports = router;
