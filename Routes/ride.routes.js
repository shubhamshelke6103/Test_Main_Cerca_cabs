// routes/ride.routes.js
const express = require('express');
const {
  createRide,
  getAllRides,
  getRideById,
  updateRide,
  deleteRide,
  getRidesByUserId,
  getUpcomingBookingsForUser,
  getRidesByDriverId,
  searchRide,
  calculateFare,
  calculateAllFares,
  generateShareLink,
  getSharedRide,
  revokeShareLink,
  serveSharedRidePage,
  createRideLiveLocationShare,
  listRideLiveLocationShares,
  revokeRideLiveLocationShare,
  getSharedLiveLocation,
  getRidePaymentSummary,
  getRiderInProgressCancelBilling,
  updateRideDestination,
  getDestinationQuote,
  acknowledgeDriverCancelSettlement,
  confirmCashDriverCancelSettlement,
  payWalletDriverCancelSettlement,
  verifyRazorpayDriverCancelSettlement,
  switchRideToCash
} = require('../Controllers/User/ride.controller');
const { sharedRideRateLimiter } = require('../middleware/shareToken.middleware');
const {
  createRidePaymentOrder,
  verifyRidePayment,
  createDriverCancelSettlementOrder
} = require('../Controllers/payment.controller');
const { destinationChangeLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Create a new ride
// POST /rides
router.post('/', createRide);

// Calculate fare
// POST /rides/calculate-fare
router.post('/calculate-fare', calculateFare);

// Calculate fare for all vehicle types
// POST /rides/calculate-all-fares
router.post('/calculate-all-fares', calculateAllFares);

// Get all rides
// GET /rides
router.get('/', getAllRides);

// Ride sharing endpoints - MUST come before /:id routes to avoid route conflicts
// GET /shared-ride/:shareToken - Serve HTML page for shared ride tracking (public, no auth)
router.get('/shared-ride/:shareToken', sharedRideRateLimiter, serveSharedRidePage);

// GET /rides/shared/:shareToken - Get shared ride data (public, no auth)
router.get('/shared/:shareToken', sharedRideRateLimiter, getSharedRide);
router.get('/live-location/shared/:shareToken', sharedRideRateLimiter, getSharedLiveLocation);

// POST /rides/:rideId/share - Generate share link (requires auth)
router.post('/:rideId/share', generateShareLink);
router.post('/:rideId/live-location/share', createRideLiveLocationShare);
router.get('/:rideId/live-location/shares', listRideLiveLocationShares);
router.delete('/:rideId/live-location/share/:shareId', revokeRideLiveLocationShare);

// DELETE /rides/:rideId/share - Revoke share linRk (requires auth)
router.delete('/:rideId/share', revokeShareLink);

// POST /rides/:rideId/pay-online - Create Razorpay order for ride payment
router.post('/:rideId/pay-online', createRidePaymentOrder);

// POST /rides/:rideId/verify-payment - Verify Razorpay payment for ride
router.post('/:rideId/verify-payment', verifyRidePayment);

// Driver in-progress cancel — rider settlement (must be before /:id)
router.post(
  '/:rideId/driver-cancel-settlement/acknowledge',
  acknowledgeDriverCancelSettlement
);
router.post(
  '/:rideId/driver-cancel-settlement/confirm-cash',
  confirmCashDriverCancelSettlement
);
router.post(
  '/:rideId/driver-cancel-settlement/pay-wallet',
  payWalletDriverCancelSettlement
);
router.post(
  '/:rideId/driver-cancel-settlement/pay-order',
  createDriverCancelSettlementOrder
);
router.post(
  '/:rideId/driver-cancel-settlement/verify-razorpay',
  verifyRazorpayDriverCancelSettlement
);

// POST /rides/:rideId/switch-to-cash - Switch an unpaid ride to cash payment
router.post('/:rideId/switch-to-cash', switchRideToCash);

// Get rides for a specific user
// GET /rides/user/:userId
router.get('/user/:userId', getRidesByUserId);

// Get upcoming bookings for a specific user
// GET /rides/user/:userId/upcoming-bookings
router.get('/user/:userId/upcoming-bookings', getUpcomingBookingsForUser);

// Get rides for a specific driver
// GET /rides/driver/:driverId
router.get('/driver/:driverId', getRidesByDriverId);

// Search for nearby drivers for a user (your controller uses req.params.id and req.body.pickupLocation)
// POST /rides/search/:id
router.post('/search/:id', searchRide);

// GET /rides/:id/destination-quote — preview new fare (before /:id)
router.get('/:id/destination-quote', destinationChangeLimiter, getDestinationQuote);

// GET /rides/:id/payment-summary — post-ride Pay Online amount and trip context
router.get('/:id/payment-summary', getRidePaymentSummary);

// GET /rides/:id/rider-in-progress-cancel-billing — rider settlement summary (driver in-trip cancel)
router.get('/:id/rider-in-progress-cancel-billing', getRiderInProgressCancelBilling);

// Get a single ride by ID - MUST come after all specific routes
// GET /rides/:id
router.get('/:id', getRideById);

// Update ride destination
// PATCH /rides/:id/destination
router.patch('/:id/destination', destinationChangeLimiter, updateRideDestination);

// Update a ride by ID
// PUT /rides/:id
router.put('/:id', updateRide);

// Delete a ride by ID
// DELETE /rides/:id
router.delete('/:id', deleteRide);

module.exports = router;
