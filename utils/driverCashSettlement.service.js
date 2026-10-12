const crypto = require('crypto');
const Razorpay = require('razorpay');
const AdminEarnings = require('../Models/Admin/adminEarnings.model');
const Driver = require('../Models/Driver/driver.model');
const logger = require('./logger');
const AppError = require('./errors/AppError');

function getRazorpayConfig() {
  const key = process.env.RAZORPAY_ID || 'rzp_live_S6q5OGF0WYChTn';
  const secret = process.env.RAZORPAY_SECRET || 'EZv5VecWiWi0FLyffYLDTM3H';
  return { key, secret };
}

function getRazorpayInstance() {
  const { key, secret } = getRazorpayConfig();
  if (!key || !secret) {
    return null;
  }
  return new Razorpay({ key_id: key, key_secret: secret });
}

/**
 * Create a Razorpay Order for a driver to pay outstanding cash platform fees.
 * @param {Object} params
 * @param {string} params.driverId
 * @param {number} [params.amount] - Optional specific amount to settle (default: total outstanding)
 * @param {string} [params.earningId] - Optional specific AdminEarnings _id to settle
 */
async function createDriverDuesOrder({ driverId, amount, earningId }) {
  const driver = await Driver.findById(driverId);
  if (!driver) {
    throw new AppError('Driver not found', 404, { code: 'DRIVER_NOT_FOUND' });
  }

  const { key } = getRazorpayConfig();
  const razorpayInstance = getRazorpayInstance();
  if (!razorpayInstance) {
    throw new AppError('Payment gateway unavailable', 503, { code: 'GATEWAY_UNAVAILABLE' });
  }

  let targetAmount = 0;
  let targetEarningIds = [];

  if (earningId) {
    const earning = await AdminEarnings.findOne({
      _id: earningId,
      driverId,
      'cashPlatformReceivable.status': 'outstanding',
    });

    if (!earning) {
      throw new AppError('No outstanding cash platform fee found for the specified earning ID', 404, {
        code: 'EARNING_NOT_FOUND',
      });
    }

    targetAmount = earning.cashPlatformReceivable?.amount ?? earning.platformFee ?? 0;
    targetEarningIds = [earning._id.toString()];
  } else {
    const outstandingEarnings = await AdminEarnings.find({
      driverId,
      'cashPlatformReceivable.status': 'outstanding',
    }).sort({ rideDate: 1 });

    const totalOutstanding = outstandingEarnings.reduce(
      (sum, e) => sum + (e.cashPlatformReceivable?.amount ?? e.platformFee ?? 0),
      0
    );

    if (totalOutstanding <= 0 || outstandingEarnings.length === 0) {
      throw new AppError('Driver has no outstanding cash platform dues', 400, {
        code: 'NO_OUTSTANDING_DUES',
      });
    }

    if (amount !== undefined && amount !== null) {
      const parsedAmount = Number(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new AppError('Invalid payment amount', 400, { code: 'INVALID_AMOUNT' });
      }
      if (parsedAmount > totalOutstanding) {
        throw new AppError(
          `Amount exceeds total outstanding dues of ₹${totalOutstanding.toFixed(2)}`,
          400,
          { code: 'AMOUNT_EXCEEDS_DUES' }
        );
      }
      targetAmount = parsedAmount;
    } else {
      targetAmount = totalOutstanding;
    }

    targetEarningIds = outstandingEarnings.map((e) => e._id.toString());
  }

  // Ensure minimum amount is at least 1 INR (100 paise)
  targetAmount = Math.round(targetAmount * 100) / 100;
  if (targetAmount < 1) {
    throw new AppError('Minimum payment amount is ₹1.00', 400, { code: 'AMOUNT_BELOW_MINIMUM' });
  }

  const amountInPaise = Math.round(targetAmount * 100);
  const receipt = `drv_due_${driverId.toString().slice(-6)}_${Date.now()}`;

  const orderPayload = {
    amount: amountInPaise,
    currency: 'INR',
    receipt,
    notes: {
      type: 'driver_cash_platform_fee_settlement',
      driverId: String(driverId),
      targetEarningIds: targetEarningIds.slice(0, 20).join(','),
      earningId: earningId ? String(earningId) : 'ALL',
    },
  };

  logger.info(`[Driver Razorpay Settlement] Creating order for driver ${driverId}`, {
    targetAmount,
    amountInPaise,
    targetEarningIdsCount: targetEarningIds.length,
    earningId: earningId || 'ALL',
  });

  const order = await razorpayInstance.orders.create(orderPayload);

  return {
    orderId: order.id,
    amount: targetAmount,
    amountInPaise: order.amount,
    currency: 'INR',
    key,
    receipt,
    targetEarningIds,
    earningId: earningId || null,
  };
}

/**
 * Verify Razorpay payment and settle driver cash platform fee dues.
 * @param {Object} params
 * @param {string} params.driverId
 * @param {string} params.razorpayOrderId
 * @param {string} params.razorpayPaymentId
 * @param {string} params.razorpaySignature
 * @param {string} [params.earningId]
 */
async function verifyAndSettleDriverDues({
  driverId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
  earningId,
}) {
  if (!driverId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new AppError('Missing required payment verification parameters', 400, {
      code: 'MISSING_PAYMENT_PARAMS',
    });
  }

  const { secret } = getRazorpayConfig();
  const razorpayInstance = getRazorpayInstance();
  if (!razorpayInstance || !secret) {
    throw new AppError('Payment gateway unavailable', 503, { code: 'GATEWAY_UNAVAILABLE' });
  }

  // 1. Cryptographically verify signature
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${razorpayOrderId}|${razorpayPaymentId}`);
  const expectedSignature = hmac.digest('hex');

  if (expectedSignature !== razorpaySignature) {
    logger.warn('[Driver Razorpay Settlement] Invalid payment signature', {
      driverId,
      razorpayOrderId,
      razorpayPaymentId,
    });
    throw new AppError('Invalid payment signature', 400, { code: 'INVALID_SIGNATURE' });
  }

  // 2. Fetch payment from Razorpay to verify status and amount
  let payment;
  try {
    payment = await razorpayInstance.payments.fetch(razorpayPaymentId);
  } catch (err) {
    logger.error('[Driver Razorpay Settlement] Failed to fetch payment from Razorpay', {
      error: err.message,
      razorpayPaymentId,
    });
    throw new AppError('Failed to verify payment with gateway', 502, {
      code: 'GATEWAY_FETCH_FAILED',
    });
  }

  if (payment.status !== 'captured') {
    logger.warn('[Driver Razorpay Settlement] Payment not captured', {
      driverId,
      status: payment.status,
      razorpayPaymentId,
    });
    throw new AppError(`Payment not captured. Status: ${payment.status}`, 400, {
      code: 'PAYMENT_NOT_CAPTURED',
    });
  }

  // 3. Idempotency Check: Verify if this paymentId was already used
  const existingSettlement = await AdminEarnings.findOne({
    'cashPlatformReceivable.razorpayPaymentId': razorpayPaymentId,
  });

  if (existingSettlement) {
    logger.info('[Driver Razorpay Settlement] Idempotent request: paymentId already settled', {
      driverId,
      razorpayPaymentId,
    });
    const remainingDues = await AdminEarnings.find({
      driverId,
      'cashPlatformReceivable.status': 'outstanding',
    });
    const remainingTotal = remainingDues.reduce(
      (sum, e) => sum + (e.cashPlatformReceivable?.amount ?? e.platformFee ?? 0),
      0
    );

    return {
      success: true,
      idempotent: true,
      message: 'Payment was already verified and settled',
      paymentId: razorpayPaymentId,
      totalSettled: Number(payment.amount) / 100,
      remainingOutstanding: Math.round(remainingTotal * 100) / 100,
      settledEarnings: [existingSettlement._id.toString()],
    };
  }

  const paymentAmountInRupees = Math.round((Number(payment.amount) / 100) * 100) / 100;
  let remainingPaidAmount = paymentAmountInRupees;
  const settledEarningsList = [];

  const now = new Date();

  // 4. Settle specific earning or distribute FIFO across outstanding dues
  if (earningId) {
    const earning = await AdminEarnings.findOne({
      _id: earningId,
      driverId,
      'cashPlatformReceivable.status': 'outstanding',
    });

    if (earning) {
      earning.cashPlatformReceivable.status = 'settled';
      earning.cashPlatformReceivable.collectedAt = now;
      earning.cashPlatformReceivable.paymentMethod = 'RAZORPAY';
      earning.cashPlatformReceivable.razorpayOrderId = razorpayOrderId;
      earning.cashPlatformReceivable.razorpayPaymentId = razorpayPaymentId;
      earning.cashPlatformReceivable.razorpaySignature = razorpaySignature;
      earning.cashPlatformReceivable.notes = `Paid online via Razorpay (${razorpayPaymentId})`;
      earning.driverPayoutEligible = false; // Cash ride driver share remains offline
      await earning.save();

      settledEarningsList.push({
        earningId: earning._id.toString(),
        settledAmount: earning.cashPlatformReceivable.amount,
        status: 'settled',
      });
    }
  } else {
    const outstandingEarnings = await AdminEarnings.find({
      driverId,
      'cashPlatformReceivable.status': 'outstanding',
    }).sort({ rideDate: 1 }); // FIFO: oldest ride date first

    for (const earning of outstandingEarnings) {
      if (remainingPaidAmount <= 0) break;

      const dueAmount = earning.cashPlatformReceivable?.amount ?? earning.platformFee ?? 0;

      if (remainingPaidAmount >= dueAmount) {
        // Full settlement for this earning
        earning.cashPlatformReceivable.status = 'settled';
        earning.cashPlatformReceivable.collectedAt = now;
        earning.cashPlatformReceivable.paymentMethod = 'RAZORPAY';
        earning.cashPlatformReceivable.razorpayOrderId = razorpayOrderId;
        earning.cashPlatformReceivable.razorpayPaymentId = razorpayPaymentId;
        earning.cashPlatformReceivable.razorpaySignature = razorpaySignature;
        earning.cashPlatformReceivable.notes = `Paid online via Razorpay (${razorpayPaymentId})`;
        earning.driverPayoutEligible = false;
        await earning.save();

        remainingPaidAmount = Math.round((remainingPaidAmount - dueAmount) * 100) / 100;
        settledEarningsList.push({
          earningId: earning._id.toString(),
          settledAmount: dueAmount,
          status: 'settled',
        });
      } else {
        // Partial settlement for this earning: deduct paid amount
        const newDue = Math.round((dueAmount - remainingPaidAmount) * 100) / 100;
        earning.cashPlatformReceivable.amount = newDue;
        earning.cashPlatformReceivable.notes = `Partial payment of ₹${remainingPaidAmount} via Razorpay (${razorpayPaymentId}). Remaining: ₹${newDue}`;
        await earning.save();

        settledEarningsList.push({
          earningId: earning._id.toString(),
          settledAmount: remainingPaidAmount,
          status: 'partial',
          remainingDue: newDue,
        });
        remainingPaidAmount = 0;
      }
    }
  }

  // 5. Calculate remaining total outstanding balance
  const remainingDues = await AdminEarnings.find({
    driverId,
    'cashPlatformReceivable.status': 'outstanding',
  });
  const remainingOutstanding = remainingDues.reduce(
    (sum, e) => sum + (e.cashPlatformReceivable?.amount ?? e.platformFee ?? 0),
    0
  );

  logger.info('[Driver Razorpay Settlement] Dues successfully settled', {
    driverId,
    totalSettled: paymentAmountInRupees,
    settledCount: settledEarningsList.length,
    remainingOutstanding: Math.round(remainingOutstanding * 100) / 100,
    razorpayPaymentId,
  });

  // 6. Realtime Socket Event
  try {
    const { getSocketIO } = require('./socket');
    const io = getSocketIO();
    if (io) {
      io.to(`driver_${driverId}`).emit('cashDuesSettled', {
        driverId,
        totalSettled: paymentAmountInRupees,
        remainingOutstanding: Math.round(remainingOutstanding * 100) / 100,
        settledEarningsCount: settledEarningsList.length,
        paymentId: razorpayPaymentId,
        timestamp: now.toISOString(),
      });
      io.to('admin').emit('driverCashDuesSettled', {
        driverId,
        totalSettled: paymentAmountInRupees,
        remainingOutstanding: Math.round(remainingOutstanding * 100) / 100,
        paymentId: razorpayPaymentId,
        timestamp: now.toISOString(),
      });
    }
  } catch (socketErr) {
    logger.warn('[Driver Razorpay Settlement] Failed to emit socket event', {
      error: socketErr.message,
    });
  }

  return {
    success: true,
    message: 'Cash platform fees settled successfully via Razorpay',
    paymentId: razorpayPaymentId,
    orderId: razorpayOrderId,
    totalSettled: paymentAmountInRupees,
    remainingOutstanding: Math.round(remainingOutstanding * 100) / 100,
    settledEarnings: settledEarningsList,
  };
}

module.exports = {
  getRazorpayConfig,
  getRazorpayInstance,
  createDriverDuesOrder,
  verifyAndSettleDriverDues,
};

