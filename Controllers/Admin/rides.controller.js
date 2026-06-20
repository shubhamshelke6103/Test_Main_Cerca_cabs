const Ride = require('../../Models/Driver/ride.model');
const Driver = require('../../Models/Driver/driver.model');
const logger = require('../../utils/logger');
const {
  buildPickupWaitAdminDetail
} = require('../../utils/pickupWaitAdminDetail');
const { cancelRide: cancelRideFromBooking, captureDriverAcceptSnapshot } = require('../../utils/ride_booking_functions');
const { getSocketIO, emitRideCancelledToClients } = require('../../utils/socket');

const SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'status', 'fare', 'actualStartTime', 'actualEndTime', 'driverTravelledKm'];

const listRides = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      paymentStatus,
      riderId,
      driverId,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (riderId) query.rider = riderId;
    if (driverId) query.driver = driverId;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const sortField = SORTABLE_FIELDS.includes(sortBy) ? sortBy : 'createdAt';
    const sortDir = sortOrder === 'asc' ? 1 : -1;
    const sortOpt = { [sortField]: sortDir };

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [rides, total] = await Promise.all([
      Ride.find(query)
        .sort(sortOpt)
        .skip(skip)
        .limit(parseInt(limit, 10))
        .populate('rider', 'fullName phoneNumber')
        .populate('driver', 'name phone'),
      Ride.countDocuments(query),
    ]);

    res.status(200).json({
      rides,
      pagination: {
        currentPage: parseInt(page, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
        total,
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    logger.error('Error fetching rides:', error);
    res.status(500).json({ message: 'Error fetching rides', error: error.message });
  }
};

const getRideById = async (req, res) => {
  try {
    const { id } = req.params;
    const ride = await Ride.findById(id)
      .populate('rider', 'fullName phoneNumber')
      .populate('driver', 'name phone');

    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }

    const pickupWaitAdminDetail = buildPickupWaitAdminDetail(ride);
    const rideObj = ride.toObject ? ride.toObject() : ride;
    rideObj.routePointCount = Array.isArray(ride.routePoints)
      ? ride.routePoints.length
      : 0;
    if (Array.isArray(ride.routePoints) && ride.routePoints.length > 0) {
      const maxPolylinePoints = 500;
      const step = Math.max(1, Math.ceil(ride.routePoints.length / maxPolylinePoints));
      rideObj.routePointsPreview = ride.routePoints.filter(
        (_, index) => index % step === 0 || index === ride.routePoints.length - 1
      );
    } else {
      rideObj.routePointsPreview = [];
    }

    res.status(200).json({
      ride: rideObj,
      pickupWaitAdminDetail
    });
  } catch (error) {
    logger.error('Error fetching ride:', error);
    res.status(500).json({ message: 'Error fetching ride', error: error.message });
  }
};

const cancelRide = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const ride = await Ride.findById(id);
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }

    // Use shared cancelRide so driver/Redis cleanup and wallet/Razorpay refunds run
    const cancelledRide = await cancelRideFromBooking(
      id,
      'system',
      reason || 'Cancelled by admin'
    );

    // Emit socket events so user and driver apps receive rideCancelled and update UI
    try {
      const io = getSocketIO();
      await emitRideCancelledToClients(
        io,
        cancelledRide,
        'system',
        reason || 'Cancelled by admin'
      );
    } catch (socketErr) {
      logger.warn('Admin cancel: socket emit failed (ride already cancelled in DB)', socketErr);
    }

    res.status(200).json({ message: 'Ride cancelled', ride: cancelledRide });
  } catch (error) {
    logger.error('Error cancelling ride:', error);
    res.status(500).json({ message: 'Error cancelling ride', error: error.message });
  }
};

const assignDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;

    if (!driverId) {
      return res.status(400).json({ message: 'driverId is required' });
    }

    const [ride, driver] = await Promise.all([
      Ride.findById(id),
      Driver.findById(driverId),
    ]);

    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    ride.driver = driverId;
    ride.status = 'accepted';
    await ride.save();

    try {
      await captureDriverAcceptSnapshot(id, driverId);
    } catch (captureErr) {
      logger.warn(`Admin assignDriver capture failed rideId=${id}: ${captureErr.message}`);
    }

    res.status(200).json({ message: 'Driver assigned', ride });
  } catch (error) {
    logger.error('Error assigning driver:', error);
    res.status(500).json({ message: 'Error assigning driver', error: error.message });
  }
};

const getRideTimeline = async (req, res) => {
  try {
    const { id } = req.params;
    const ride = await Ride.findById(id);

    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' });
    }

    const pickupWaitDetail = buildPickupWaitAdminDetail(ride);

    const events = [];

    const push = (label, time, extra = {}) => {
      if (time) {
        events.push({ label, time, ...extra });
      }
    };

    push('Ride Requested', ride.createdAt);
    push('Driver Assigned', ride.driver ? ride.updatedAt : null);
    push('Driver Arrived', ride.driverArrivedAt);

    if (pickupWaitDetail && pickupWaitDetail.present === true) {
      const endAt =
        ride.actualStartTime ||
        ride.startOtpVerifiedAt ||
        ride.pickupWait?.waitEndedAt ||
        pickupWaitDetail.waitEndedAt;
      push('Pickup wait (arrival → start OTP)', endAt, {
        type: 'pickup_wait',
        startedAt:
          pickupWaitDetail.waitStartedAt ||
          ride.driverArrivedAt ||
          ride.pickupWait?.waitStartedAt,
        endedAt:
          pickupWaitDetail.waitEndedAt ||
          ride.actualStartTime ||
          ride.pickupWait?.waitEndedAt,
        durationSeconds: pickupWaitDetail.durationSeconds,
        durationLabel: pickupWaitDetail.durationLabel,
        amount: pickupWaitDetail.totalPickupWaitCharge,
        detail: pickupWaitDetail
      });
    }

    push('Start OTP verified / trip start', ride.startOtpVerifiedAt || ride.actualStartTime);

    if (Array.isArray(ride.destinationChangeLog) && ride.destinationChangeLog.length > 0) {
      for (const entry of ride.destinationChangeLog) {
        if (!entry || !entry.at) continue;
        push('Destination changed', entry.at, {
          type: 'destination_change',
          previousFare: entry.previousFare,
          newFare: entry.newFare,
          previousDropoffAddress: entry.previousDropoffAddress,
          newDropoffAddress: entry.newDropoffAddress,
          pricingOriginSource: entry.pricingOriginSource
        });
      }
    }

    push('Ride completed (stop OTP)', ride.stopOtpVerifiedAt || ride.actualEndTime);
    push('Ride Cancelled', ride.status === 'cancelled' ? ride.updatedAt : null);

    events.sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return ta - tb;
    });

    res.status(200).json({
      events,
      pickupWaitDetail,
      pickupWaitSummary: pickupWaitDetail
    });
  } catch (error) {
    logger.error('Error fetching ride timeline:', error);
    res.status(500).json({ message: 'Error fetching ride timeline', error: error.message });
  }
};

module.exports = {
  listRides,
  getRideById,
  cancelRide,
  assignDriver,
  getRideTimeline,
};

