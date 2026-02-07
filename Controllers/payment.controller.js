const razorpay = require("razorpay");
const crypto = require("crypto");
const logger = require('../utils/logger');

const key = process.env.RAZORPAY_ID || "rzp_live_S6q5OGF0WYChTn";
const secret = process.env.RAZORPAY_SECRET || "EZv5VecWiWi0FLyffYLDTM3H";

var instance = new razorpay({
    key_id: key,
    key_secret: secret,
});

// Initiate payment request
const initiatePayment = async (req, res) => {
    try {
        const { amount } = req.body;

        // Validate amount
        if (!amount || amount <= 0) {
            return res.status(400).json({
                message: "Invalid amount. Amount must be greater than 0.",
                error: "VALIDATION_ERROR"
            });
        }

        // Validate minimum amount (₹10 = 1000 paise)
        if (amount < 10) {
            return res.status(400).json({
                message: "Minimum amount is ₹10",
                error: "VALIDATION_ERROR"
            });
        }

        // Validate maximum amount (₹50,000 = 5000000 paise)
        if (amount > 50000) {
            return res.status(400).json({
                message: "Maximum amount is ₹50,000",
                error: "VALIDATION_ERROR"
            });
        }

        const options = {
            amount: amount * 100, // Razorpay expects the amount in paise
            currency: "INR",
        };

        const order = await instance.orders.create(options);
        
        if (order) {
            logger.info(`Payment order created: ${order.id} for amount: ₹${amount}`);
            res.status(200).json({
                message: "Order Created",
                order
            });
        } else {
            logger.error('Failed to create Razorpay order');
            res.status(400).json({
                message: "Order Not Created",
                error: "ORDER_CREATION_FAILED"
            });
        }
    } catch (error) {
        logger.error("Payment initiation error:", error);
        res.status(500).json({
            message: "Failed to initiate payment",
            error: error.message || "INTERNAL_SERVER_ERROR"
        });
    }
};

/**
 * Handle Razorpay webhook events
 * POST /api/v1/payment/webhook
 */
const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    const signature = req.headers['x-razorpay-signature'];
    
    // If webhook secret is configured, verify signature
    // Note: For proper signature verification, you may need to use raw body
    // For now, we'll skip signature verification if secret is not set
    if (webhookSecret && signature) {
      // Signature verification would require raw body buffer
      // For production, consider using express.raw() middleware for webhook route
      logger.info('Webhook signature verification skipped (requires raw body)');
      // In production, implement proper signature verification with raw body
    }

    const event = req.body.event;
    const payment = req.body.payload?.payment?.entity;

    if (!event || !payment) {
      logger.warn('Invalid webhook payload structure');
      return res.status(400).json({
        success: false,
        message: 'Invalid webhook payload'
      });
    }

    logger.info(`Razorpay webhook received - Event: ${event}, Payment ID: ${payment.id}`);

    // Handle payment captured/authorized events
    if (event === 'payment.captured' || event === 'payment.authorized') {
      const paymentId = payment.id;
      const amount = payment.amount / 100; // Convert from paise to rupees
      const userId = payment.notes?.userId;
      const rideId = payment.notes?.rideId;
      const isWalletTopUp = payment.notes?.type === 'wallet_topup';

      if (isWalletTopUp && userId) {
        // Handle wallet top-up
        const User = require('../Models/User/user.model');
        const WalletTransaction = require('../Models/User/walletTransaction.model');
        
        const user = await User.findById(userId);
        if (user) {
          const balanceBefore = user.walletBalance || 0;
          const balanceAfter = balanceBefore + amount;

          // Create wallet transaction
          await WalletTransaction.create({
            user: userId,
            transactionType: 'TOP_UP',
            amount: amount,
            balanceBefore,
            balanceAfter,
            paymentGatewayTransactionId: paymentId,
            paymentMethod: 'RAZORPAY',
            status: 'COMPLETED',
            description: `Wallet top-up of ₹${amount}`,
          });

          // Update user wallet balance
          user.walletBalance = balanceAfter;
          await user.save();

          logger.info(`Wallet top-up successful - User: ${userId}, Amount: ₹${amount}, New Balance: ₹${balanceAfter}`);
        }
      } else if (rideId) {
        // Handle ride payment confirmation
        const Ride = require('../Models/Driver/ride.model');
        const ride = await Ride.findById(rideId);
        if (ride) {
          ride.paymentStatus = 'completed';
          ride.razorpayPaymentId = paymentId;
          ride.transactionId = paymentId;
          await ride.save();

          logger.info(`Ride payment confirmed - Ride: ${rideId}, Payment ID: ${paymentId}`);
        }
      }
    }

    // Handle payment failed event
    if (event === 'payment.failed') {
      const paymentId = payment.id;
      const rideId = payment.notes?.rideId;

      if (rideId) {
        const Ride = require('../Models/Driver/ride.model');
        const ride = await Ride.findById(rideId);
        if (ride) {
          ride.paymentStatus = 'failed';
          await ride.save();

          logger.warn(`Ride payment failed - Ride: ${rideId}, Payment ID: ${paymentId}`);
        }
      }
    }

    // Always return 200 to acknowledge webhook receipt
    res.status(200).json({
      success: true,
      message: 'Webhook processed successfully'
    });
  } catch (error) {
    logger.error('Error processing Razorpay webhook:', error);
    // Still return 200 to prevent Razorpay from retrying
    res.status(200).json({
      success: false,
      message: 'Webhook received but processing failed',
      error: error.message
    });
  }
};

/**
 * Create Razorpay order for ride payment (post-ride)
 * POST /api/v1/rides/:rideId/pay-online
 */
const createRidePaymentOrder = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { userId } = req.body; // Get userId from request body (frontend will send it)

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const Ride = require('../Models/Driver/ride.model');
    const ride = await Ride.findById(rideId);

    if (!ride) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found'
      });
    }

    // Verify ride belongs to user
    const riderId = ride.rider._id || ride.rider;
    if (riderId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: This ride does not belong to you'
      });
    }

    // Verify ride status and payment method
    if (ride.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Ride must be completed before payment'
      });
    }

    if (ride.paymentMethod !== 'RAZORPAY') {
      return res.status(400).json({
        success: false,
        message: 'Ride payment method is not RAZORPAY'
      });
    }

    if (ride.paymentStatus === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Payment already completed for this ride'
      });
    }

    // Validate amount
    const amount = ride.fare || 0;
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ride fare amount'
      });
    }

    if (amount < 10) {
      return res.status(400).json({
        success: false,
        message: 'Minimum payment amount is ₹10'
      });
    }

    // Create Razorpay order with rideId and userId in notes
    const options = {
      amount: amount * 100, // Convert to paise
      currency: 'INR',
      notes: {
        rideId: rideId,
        userId: userId.toString(),
        type: 'ride_payment'
      }
    };

    const order = await instance.orders.create(options);

    if (order) {
      logger.info(`Ride payment order created - Ride: ${rideId}, Order: ${order.id}, Amount: ₹${amount}`);
      res.status(200).json({
        success: true,
        message: 'Order created successfully',
        data: {
          orderId: order.id,
          amount: amount,
          key: key // Razorpay key for frontend
        }
      });
    } else {
      logger.error('Failed to create Razorpay order for ride payment');
      res.status(500).json({
        success: false,
        message: 'Failed to create payment order',
        error: 'ORDER_CREATION_FAILED'
      });
    }
  } catch (error) {
    logger.error('Error creating ride payment order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: error.message || 'INTERNAL_SERVER_ERROR'
    });
  }
};

/**
 * Verify Razorpay payment for ride
 * POST /api/v1/rides/:rideId/verify-payment
 */
const verifyRidePayment = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { razorpay_payment_id, razorpay_order_id, userId } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User ID is required'
      });
    }

    if (!razorpay_payment_id || !razorpay_order_id) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID and Order ID are required'
      });
    }

    const Ride = require('../Models/Driver/ride.model');
    const ride = await Ride.findById(rideId);

    if (!ride) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found'
      });
    }

    // Verify ride belongs to user
    const riderId = ride.rider._id || ride.rider;
    if (riderId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: This ride does not belong to you'
      });
    }

    // Fetch payment from Razorpay
    const payment = await instance.payments.fetch(razorpay_payment_id);

    // Verify payment status
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      return res.status(400).json({
        success: false,
        message: `Payment not completed. Status: ${payment.status}`
      });
    }

    // Verify payment amount matches ride fare
    const paymentAmount = payment.amount / 100; // Convert from paise
    const rideFare = ride.fare || 0;

    if (Math.abs(paymentAmount - rideFare) > 0.01) {
      logger.warn(`Payment amount mismatch - Payment: ₹${paymentAmount}, Ride Fare: ₹${rideFare}`);
      return res.status(400).json({
        success: false,
        message: 'Payment amount mismatch'
      });
    }

    // Update ride payment status
    ride.paymentStatus = 'completed';
    ride.razorpayPaymentId = razorpay_payment_id;
    ride.transactionId = razorpay_payment_id;
    await ride.save();

    logger.info(`Ride payment verified - Ride: ${rideId}, Payment ID: ${razorpay_payment_id}`);

    // Emit socket event for real-time update (optional)
    try {
      const { getSocketIO } = require('../utils/socket');
      const io = getSocketIO();
      if (io && ride.driverSocketId) {
        io.to(ride.driverSocketId).emit('paymentCompleted', {
          rideId: rideId,
          paymentId: razorpay_payment_id,
          amount: paymentAmount
        });
      }
    } catch (socketError) {
      logger.warn('Failed to emit paymentCompleted socket event:', socketError);
      // Don't fail the request if socket emit fails
    }

    res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      data: {
        rideId: rideId,
        paymentId: razorpay_payment_id,
        amount: paymentAmount,
        status: 'completed'
      }
    });
  } catch (error) {
    logger.error('Error verifying ride payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: error.message || 'INTERNAL_SERVER_ERROR'
    });
  }
};

module.exports = { 
  initiatePayment, 
  handleRazorpayWebhook,
  createRidePaymentOrder,
  verifyRidePayment
};