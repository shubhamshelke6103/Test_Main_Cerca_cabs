const Ride = require('../../Models/Driver/ride.model');
const User = require('../../Models/User/user.model');
const WalletTransaction = require('../../Models/User/walletTransaction.model');
const Payout = require('../../Models/Driver/payout.model');
const VendorPayout = require('../../Models/Vendor/vendorPayout.model');
const Vendor = require('../../Models/vendor/vendor.models');
const { syncVendorFinancialFields } = require('../../Controllers/Vendor/vendor.controller');
const AdminEarnings = require('../../Models/Admin/adminEarnings.model');
const logger = require('../../utils/logger');

const listPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, paymentMethod } = req.query;
    const query = {};

    if (status) query.paymentStatus = status;
    if (paymentMethod) query.paymentMethod = paymentMethod;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [rides, total] = await Promise.all([
      Ride.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .populate('rider', 'fullName phoneNumber')
        .populate('driver', 'name phone')
        .select('fare paymentStatus paymentMethod walletAmountUsed razorpayAmountPaid transactionId createdAt'),
      Ride.countDocuments(query),
    ]);

    res.status(200).json({
      payments: rides,
      pagination: {
        currentPage: parseInt(page, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
        total,
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    logger.error('Error fetching payments:', error);
    res.status(500).json({ message: 'Error fetching payments', error: error.message });
  }
};

const refundPayment = async (req, res) => {
  try {
    const { rideId, reason } = req.body;

    if (!rideId) {
      return res.status(400).json({ message: 'rideId is required' });
    }

    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }

    ride.paymentStatus = 'refunded';
    if (reason) ride.cancellationReason = reason;
    await ride.save();

    if (ride.walletAmountUsed > 0) {
      const user = await User.findById(ride.rider);
      if (user) {
        const balanceBefore = user.walletBalance || 0;
        const balanceAfter = balanceBefore + ride.walletAmountUsed;

        user.walletBalance = balanceAfter;
        await user.save();

        await WalletTransaction.create({
          user: user._id,
          transactionType: 'REFUND',
          amount: ride.walletAmountUsed,
          balanceBefore,
          balanceAfter,
          relatedRide: ride._id,
          paymentMethod: 'WALLET',
          status: 'COMPLETED',
          description: `Refund for ride ${ride._id}`,
          adjustedBy: req.adminId,
        });
      }
    }

    res.status(200).json({ message: 'Payment refunded', ride });
  } catch (error) {
    logger.error('Error processing refund:', error);
    res.status(500).json({ message: 'Error processing refund', error: error.message });
  }
};

const listPayouts = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, driverId } = req.query;
    const query = {};
    if (status) query.status = status;
    if (driverId) query.driver = driverId;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [payouts, total] = await Promise.all([
      Payout.find(query)
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .populate('driver', 'name phone')
        .populate('processedBy', 'fullName email'),
      Payout.countDocuments(query),
    ]);

    res.status(200).json({
      payouts,
      pagination: {
        currentPage: parseInt(page, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
        total,
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    logger.error('Error fetching payouts:', error);
    res.status(500).json({ message: 'Error fetching payouts', error: error.message });
  }
};

const processPayout = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, transactionId, transactionReference, failureReason, notes } = req.body;

    const allowed = ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid payout status' });
    }

    const payout = await Payout.findById(id);
    if (!payout) {
      return res.status(404).json({ message: 'Payout not found' });
    }

    if (status === 'COMPLETED' && payout.relatedEarnings?.length) {
      const alreadyPaid = await AdminEarnings.find({
        _id: { $in: payout.relatedEarnings },
        paymentStatus: 'completed'
      }).select('_id');

      if (alreadyPaid.length > 0) {
        return res.status(400).json({
          message: 'Some earnings are already marked as completed for this payout',
          data: {
            earningIds: alreadyPaid.map((earning) => earning._id)
          }
        });
      }
    }

    payout.status = status;
    payout.processedAt = new Date();
    payout.processedBy = req.adminId;
    if (transactionId) payout.transactionId = transactionId;
    if (transactionReference) payout.transactionReference = transactionReference;
    if (failureReason) payout.failureReason = failureReason;
    if (notes) payout.notes = notes;

    await payout.save();

    if (status === 'COMPLETED' && payout.relatedEarnings?.length) {
      await AdminEarnings.updateMany(
        { _id: { $in: payout.relatedEarnings } },
        { $set: { paymentStatus: 'completed' } }
      );
    }

    res.status(200).json({ message: 'Payout updated', payout });
  } catch (error) {
    logger.error('Error processing payout:', error);
    res.status(500).json({ message: 'Error processing payout', error: error.message });
  }
};

const listVendorPayouts = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, vendorId } = req.query;
    const query = {};
    if (status) query.status = status;
    if (vendorId) query.vendor = vendorId;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [payouts, total] = await Promise.all([
      VendorPayout.find(query)
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .populate('vendor', 'businessName email phone walletBalance')
        .populate('processedBy', 'fullName email'),
      VendorPayout.countDocuments(query),
    ]);

    res.status(200).json({
      payouts,
      pagination: {
        currentPage: parseInt(page, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
        total,
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    logger.error('Error fetching vendor payouts:', error);
    res.status(500).json({ message: 'Error fetching vendor payouts', error: error.message });
  }
};

const processVendorPayout = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, transactionId, transactionReference, failureReason, notes } = req.body;

    const allowed = ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid payout status' });
    }

    const payout = await VendorPayout.findById(id);
    if (!payout) {
      return res.status(404).json({ message: 'Vendor payout not found' });
    }

    const prevStatus = payout.status;

    let vendorAfterCompletion = null;

    if (status === 'COMPLETED' && prevStatus !== 'COMPLETED') {
      const updated = await Vendor.findOneAndUpdate(
        { _id: payout.vendor, walletBalance: { $gte: payout.amount } },
        { $inc: { walletBalance: -payout.amount } },
        { new: true }
      );
      if (!updated) {
        return res.status(400).json({
          message: 'Vendor wallet balance is insufficient to complete this payout',
        });
      }
      vendorAfterCompletion = updated;
    }

    if (
      prevStatus === 'COMPLETED' &&
      prevStatus !== status &&
      (status === 'FAILED' || status === 'CANCELLED')
    ) {
      await Vendor.findByIdAndUpdate(payout.vendor, { $inc: { walletBalance: payout.amount } });
    }

    payout.status = status;
    payout.processedAt = new Date();
    payout.processedBy = req.adminId;
    if (transactionId) payout.transactionId = transactionId;
    if (transactionReference) payout.transactionReference = transactionReference;
    if (failureReason) payout.failureReason = failureReason;
    if (notes) payout.notes = notes;

    await payout.save();
    await syncVendorFinancialFields(payout.vendor);

    if (vendorAfterCompletion) {
      try {
        const { getSocketIO } = require('../../utils/socket');
        const io = getSocketIO();
        if (io) {
          const vid = String(payout.vendor);
          io.to(`vendor_${vid}`).emit('vendorPayoutCompleted', {
            payoutId: String(payout._id),
            amount: payout.amount,
            newWalletBalance: vendorAfterCompletion.walletBalance,
            currency: 'INR',
          });
        }
      } catch (sockErr) {
        logger.warn('vendorPayoutCompleted socket emit failed:', sockErr.message);
      }
    }

    res.status(200).json({ message: 'Vendor payout updated', payout });
  } catch (error) {
    logger.error('Error processing vendor payout:', error);
    res.status(500).json({ message: 'Error processing vendor payout', error: error.message });
  }
};

module.exports = {
  listPayments,
  refundPayment,
  listPayouts,
  processPayout,
  listVendorPayouts,
  processVendorPayout,
};

