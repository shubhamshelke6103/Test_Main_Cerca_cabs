const User = require('../../Models/User/user.model');
const WalletTransaction = require('../../Models/User/walletTransaction.model');
const logger = require('../../utils/logger');
const AppError = require('../../utils/errors/AppError');
const asyncHandler = require('../../utils/errors/asyncHandler');

const getUserOrThrow = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND',
    });
  }
  return user;
};

const getUserWallet = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const user = await User.findById(userId).select('walletBalance fullName email phoneNumber');
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND',
    });
  }

  res.status(200).json({
    success: true,
    data: {
      userId: user._id,
      walletBalance: user.walletBalance || 0,
      currency: 'INR',
      user: {
        name: user.fullName,
        email: user.email,
        phone: user.phoneNumber,
      },
    },
  });
});

const getWalletTransactions = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const {
    page = 1,
    limit = 20,
    transactionType,
    status,
    startDate,
    endDate,
  } = req.query;

  const user = await getUserOrThrow(userId);

  const query = { user: userId };
  if (transactionType) {
    query.transactionType = transactionType;
  }
  if (status) {
    query.status = status;
  }
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      query.createdAt.$lte = new Date(endDate);
    }
  }

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  const skip = (parsedPage - 1) * parsedLimit;

  const transactions = await WalletTransaction.find(query)
    .populate('relatedRide', 'pickupAddress dropoffAddress fare status')
    .populate('adjustedBy', 'fullName email')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parsedLimit);

  const totalTransactions = await WalletTransaction.countDocuments(query);

  const summary = await WalletTransaction.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        totalCredits: {
          $sum: {
            $cond: [
              { $in: ['$transactionType', ['TOP_UP', 'REFUND', 'BONUS', 'REFERRAL_REWARD', 'PROMO_CREDIT', 'ADMIN_ADJUSTMENT']] },
              '$amount',
              0,
            ],
          },
        },
        totalDebits: {
          $sum: {
            $cond: [
              { $in: ['$transactionType', ['RIDE_PAYMENT', 'WITHDRAWAL', 'CANCELLATION_FEE']] },
              '$amount',
              0,
            ],
          },
        },
      },
    },
  ]);

  res.status(200).json({
    success: true,
    data: {
      transactions,
      pagination: {
        currentPage: parsedPage,
        totalPages: Math.ceil(totalTransactions / parsedLimit),
        totalTransactions,
        limit: parsedLimit,
      },
      summary: summary[0] || { totalCredits: 0, totalDebits: 0 },
      currentBalance: user.walletBalance || 0,
    },
  });
});

const topUpWallet = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { amount, paymentMethod, paymentGatewayTransactionId, description } = req.body;

  if (!amount || amount <= 0) {
    throw new AppError('Invalid amount. Amount must be greater than 0', 400, {
      code: 'INVALID_TOPUP_AMOUNT',
    });
  }
  if (amount < 10) {
    throw new AppError('Minimum top-up amount is Rs10', 400, {
      code: 'MIN_TOPUP_NOT_MET',
    });
  }
  if (amount > 50000) {
    throw new AppError('Maximum top-up amount is Rs50,000', 400, {
      code: 'MAX_TOPUP_EXCEEDED',
    });
  }

  const user = await getUserOrThrow(userId);
  const balanceBefore = user.walletBalance || 0;
  const balanceAfter = balanceBefore + amount;

  const transaction = await WalletTransaction.create({
    user: userId,
    transactionType: 'TOP_UP',
    amount,
    balanceBefore,
    balanceAfter,
    paymentMethod: paymentMethod || 'RAZORPAY',
    paymentGatewayTransactionId,
    status: 'COMPLETED',
    description: description || `Wallet top-up of Rs${amount}`,
    metadata: {
      topUpMethod: paymentMethod,
      gatewayTransactionId: paymentGatewayTransactionId,
    },
  });

  user.walletBalance = balanceAfter;
  await user.save();

  logger.info(`Wallet top-up successful - User: ${userId}, Amount: Rs${amount}, New Balance: Rs${balanceAfter}`);

  res.status(200).json({
    success: true,
    message: 'Wallet topped up successfully',
    data: {
      transaction,
      newBalance: balanceAfter,
      previousBalance: balanceBefore,
    },
  });
});

const deductFromWallet = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { amount, rideId, description } = req.body;

  if (!amount || amount <= 0) {
    throw new AppError('Invalid amount', 400, {
      code: 'INVALID_DEDUCTION_AMOUNT',
    });
  }

  const user = await getUserOrThrow(userId);
  const balanceBefore = user.walletBalance || 0;

  if (balanceBefore < amount) {
    throw new AppError('Insufficient wallet balance', 400, {
      code: 'INSUFFICIENT_WALLET_BALANCE',
      details: {
        required: amount,
        available: balanceBefore,
        shortfall: amount - balanceBefore,
      },
    });
  }

  const balanceAfter = balanceBefore - amount;

  const transaction = await WalletTransaction.create({
    user: userId,
    transactionType: 'RIDE_PAYMENT',
    amount,
    balanceBefore,
    balanceAfter,
    relatedRide: rideId,
    paymentMethod: 'WALLET',
    status: 'COMPLETED',
    description: description || `Ride payment of Rs${amount}`,
  });

  user.walletBalance = balanceAfter;
  await user.save();

  logger.info(`Wallet deduction successful - User: ${userId}, Amount: Rs${amount}, New Balance: Rs${balanceAfter}`);

  res.status(200).json({
    success: true,
    message: 'Amount deducted successfully',
    data: {
      transaction,
      newBalance: balanceAfter,
      previousBalance: balanceBefore,
    },
  });
});

const refundToWallet = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { amount, rideId, reason, description } = req.body;

  if (!amount || amount <= 0) {
    throw new AppError('Invalid refund amount', 400, {
      code: 'INVALID_REFUND_AMOUNT',
    });
  }

  const user = await getUserOrThrow(userId);
  const balanceBefore = user.walletBalance || 0;
  const balanceAfter = balanceBefore + amount;

  const transaction = await WalletTransaction.create({
    user: userId,
    transactionType: 'REFUND',
    amount,
    balanceBefore,
    balanceAfter,
    relatedRide: rideId,
    paymentMethod: 'WALLET',
    status: 'COMPLETED',
    description: description || `Refund of Rs${amount}${reason ? ` - ${reason}` : ''}`,
    metadata: {
      refundReason: reason,
    },
  });

  user.walletBalance = balanceAfter;
  await user.save();

  logger.info(`Wallet refund successful - User: ${userId}, Amount: Rs${amount}, New Balance: Rs${balanceAfter}`);

  res.status(200).json({
    success: true,
    message: 'Refund processed successfully',
    data: {
      transaction,
      newBalance: balanceAfter,
      previousBalance: balanceBefore,
    },
  });
});

const requestWithdrawal = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const {
    amount,
    bankAccountNumber,
    ifscCode,
    accountHolderName,
    bankName,
    description,
  } = req.body;

  if (!amount || amount <= 0) {
    throw new AppError('Invalid withdrawal amount', 400, {
      code: 'INVALID_WITHDRAWAL_AMOUNT',
    });
  }
  if (amount < 100) {
    throw new AppError('Minimum withdrawal amount is Rs100', 400, {
      code: 'MIN_WITHDRAWAL_NOT_MET',
    });
  }
  if (!bankAccountNumber || !ifscCode || !accountHolderName || !bankName) {
    throw new AppError('Bank account details are required', 400, {
      code: 'BANK_DETAILS_REQUIRED',
    });
  }

  const user = await getUserOrThrow(userId);
  const balanceBefore = user.walletBalance || 0;

  if (balanceBefore < amount) {
    throw new AppError('Insufficient wallet balance', 400, {
      code: 'INSUFFICIENT_WALLET_BALANCE',
      details: {
        required: amount,
        available: balanceBefore,
      },
    });
  }

  const balanceAfter = balanceBefore - amount;

  const transaction = await WalletTransaction.create({
    user: userId,
    transactionType: 'WITHDRAWAL',
    amount,
    balanceBefore,
    balanceAfter,
    paymentMethod: 'NETBANKING',
    status: 'PENDING',
    description: description || `Withdrawal request of Rs${amount}`,
    withdrawalRequest: {
      bankAccountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      requestedAt: new Date(),
    },
  });

  user.walletBalance = balanceAfter;
  await user.save();

  logger.info(`Withdrawal request created - User: ${userId}, Amount: Rs${amount}, Transaction: ${transaction._id}`);

  res.status(200).json({
    success: true,
    message: 'Withdrawal request submitted successfully. It will be processed within 3-5 business days.',
    data: {
      transaction,
      newBalance: balanceAfter,
      previousBalance: balanceBefore,
    },
  });
});

const getWalletTransactionById = asyncHandler(async (req, res) => {
  const { userId, transactionId } = req.params;

  const transaction = await WalletTransaction.findOne({
    _id: transactionId,
    user: userId,
  })
    .populate('relatedRide', 'pickupAddress dropoffAddress fare status')
    .populate('adjustedBy', 'fullName email')
    .populate('withdrawalRequest.processedBy', 'fullName email');

  if (!transaction) {
    throw new AppError('Transaction not found', 404, {
      code: 'TRANSACTION_NOT_FOUND',
    });
  }

  res.status(200).json({
    success: true,
    data: {
      transaction,
    },
  });
});

const getWalletStatistics = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { startDate, endDate } = req.query;

  const user = await getUserOrThrow(userId);

  const dateFilter = { user: userId };
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) {
      dateFilter.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      dateFilter.createdAt.$lte = new Date(endDate);
    }
  }

  const stats = await WalletTransaction.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: null,
        totalTopUps: {
          $sum: {
            $cond: [{ $eq: ['$transactionType', 'TOP_UP'] }, '$amount', 0],
          },
        },
        totalRidePayments: {
          $sum: {
            $cond: [{ $eq: ['$transactionType', 'RIDE_PAYMENT'] }, '$amount', 0],
          },
        },
        totalRefunds: {
          $sum: {
            $cond: [{ $eq: ['$transactionType', 'REFUND'] }, '$amount', 0],
          },
        },
        totalBonuses: {
          $sum: {
            $cond: [{ $eq: ['$transactionType', 'BONUS'] }, '$amount', 0],
          },
        },
        totalWithdrawals: {
          $sum: {
            $cond: [{ $eq: ['$transactionType', 'WITHDRAWAL'] }, '$amount', 0],
          },
        },
        transactionCount: { $sum: 1 },
      },
    },
  ]);

  const transactionsByType = await WalletTransaction.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: '$transactionType',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
      },
    },
  ]);

  const monthlyBreakdown = await WalletTransaction.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
        },
        credits: {
          $sum: {
            $cond: [
              { $in: ['$transactionType', ['TOP_UP', 'REFUND', 'BONUS', 'REFERRAL_REWARD', 'PROMO_CREDIT']] },
              '$amount',
              0,
            ],
          },
        },
        debits: {
          $sum: {
            $cond: [
              { $in: ['$transactionType', ['RIDE_PAYMENT', 'WITHDRAWAL', 'CANCELLATION_FEE']] },
              '$amount',
              0,
            ],
          },
        },
      },
    },
    { $sort: { '_id.year': -1, '_id.month': -1 } },
  ]);

  res.status(200).json({
    success: true,
    data: {
      currentBalance: user.walletBalance || 0,
      statistics: stats[0] || {
        totalTopUps: 0,
        totalRidePayments: 0,
        totalRefunds: 0,
        totalBonuses: 0,
        totalWithdrawals: 0,
        transactionCount: 0,
      },
      transactionsByType,
      monthlyBreakdown,
    },
  });
});

const processHybridPayment = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { rideId, totalAmount, walletAmount, razorpayPaymentId } = req.body;

  if (!rideId) {
    throw new AppError('Ride ID is required', 400, {
      code: 'RIDE_ID_REQUIRED',
    });
  }
  if (!totalAmount || totalAmount <= 0) {
    throw new AppError('Invalid total amount', 400, {
      code: 'INVALID_TOTAL_AMOUNT',
    });
  }
  if (walletAmount === undefined || walletAmount < 0) {
    throw new AppError('Invalid wallet amount', 400, {
      code: 'INVALID_WALLET_AMOUNT',
    });
  }
  if (!razorpayPaymentId) {
    throw new AppError('Razorpay payment ID is required', 400, {
      code: 'RAZORPAY_PAYMENT_ID_REQUIRED',
    });
  }

  const razorpayAmount = totalAmount - walletAmount;
  if (razorpayAmount < 0) {
    throw new AppError('Wallet amount cannot exceed total amount', 400, {
      code: 'WALLET_AMOUNT_EXCEEDS_TOTAL',
    });
  }

  const user = await getUserOrThrow(userId);
  const balanceBefore = user.walletBalance || 0;

  if (walletAmount > 0 && balanceBefore < walletAmount) {
    throw new AppError('Insufficient wallet balance', 400, {
      code: 'INSUFFICIENT_WALLET_BALANCE',
      details: {
        required: walletAmount,
        available: balanceBefore,
        shortfall: walletAmount - balanceBefore,
      },
    });
  }

  const Ride = require('../../Models/Driver/ride.model');
  const ride = await Ride.findById(rideId);
  if (!ride) {
    throw new AppError('Ride not found', 404, {
      code: 'RIDE_NOT_FOUND',
    });
  }

  let walletTransaction = null;
  let balanceAfter = balanceBefore;

  try {
    if (walletAmount > 0) {
      balanceAfter = balanceBefore - walletAmount;
      walletTransaction = await WalletTransaction.create({
        user: userId,
        transactionType: 'RIDE_PAYMENT',
        amount: walletAmount,
        balanceBefore,
        balanceAfter,
        relatedRide: rideId,
        paymentMethod: 'WALLET',
        status: 'COMPLETED',
        description: `Ride payment (hybrid) - Wallet: Rs${walletAmount}, Razorpay: Rs${razorpayAmount}`,
        metadata: {
          hybridPayment: true,
          razorpayPaymentId,
          totalAmount,
        },
      });

      user.walletBalance = balanceAfter;
      await user.save();
    }

    ride.walletAmountUsed = walletAmount;
    ride.razorpayAmountPaid = razorpayAmount;
    ride.razorpayPaymentId = razorpayPaymentId;
    ride.paymentStatus = 'completed';
    ride.transactionId = razorpayPaymentId;
    await ride.save();
  } catch (error) {
    logger.error('Error processing hybrid payment:', error);

    if (walletAmount > 0) {
      try {
        const refreshUser = await User.findById(userId);
        if (refreshUser) {
          const refundedBalanceBefore = refreshUser.walletBalance || 0;
          refreshUser.walletBalance = refundedBalanceBefore + walletAmount;
          await refreshUser.save();

          await WalletTransaction.create({
            user: userId,
            transactionType: 'REFUND',
            amount: walletAmount,
            balanceBefore: refundedBalanceBefore,
            balanceAfter: refreshUser.walletBalance,
            relatedRide: rideId,
            paymentMethod: 'WALLET',
            status: 'COMPLETED',
            description: 'Refund due to hybrid payment processing error',
            metadata: {
              originalError: error.message,
            },
          });

          logger.info(`Wallet refunded due to hybrid payment error - User: ${userId}, Amount: Rs${walletAmount}`);
        }
      } catch (refundError) {
        logger.error('Error refunding wallet after hybrid payment failure:', refundError);
      }
    }

    throw error;
  }

  logger.info(`Hybrid payment processed - User: ${userId}, Ride: ${rideId}, Wallet: Rs${walletAmount}, Razorpay: Rs${razorpayAmount}`);

  res.status(200).json({
    success: true,
    message: 'Hybrid payment processed successfully',
    data: {
      walletTransaction,
      newBalance: balanceAfter,
      previousBalance: balanceBefore,
      razorpayAmount,
      walletAmount,
      totalAmount,
    },
  });
});

module.exports = {
  getUserWallet,
  getWalletTransactions,
  topUpWallet,
  deductFromWallet,
  refundToWallet,
  requestWithdrawal,
  getWalletTransactionById,
  getWalletStatistics,
  processHybridPayment,
};
