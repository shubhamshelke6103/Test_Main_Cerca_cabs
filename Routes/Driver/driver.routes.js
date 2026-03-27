const express = require('express');
const multer = require('multer');
const {
    addDriver,
    loginDriver,
    getAllDrivers,
    getDriverById,
    deleteDriver,
    updateDriver,
    addDriverDocuments,
    updateDriverDocuments,
    getDriverDocuments,
    getAllRidesOfDriver,
    updateDriverLocation,
    updateDriverOnlineStatus,
    logoutDriver,
    updateDriverVehicle,
    getDriverStats,
    getNearbyDrivers,
    updateDriverBusyStatus,
    getUpcomingBookings,
    markCashCollected,
    uploadPriorityDocument,
    getDriverOnlineHours,
    updateDriverComplianceDocuments,
    createDriverLocationShare,
    listDriverLocationShares,
    deleteDriverLocationShare,
    getSharedDriverLocation
} = require('../../Controllers/Driver/driver.controller.js');
const { authenticateDriver } = require('../../utils/driverAuth');
const { sharedLiveLocationRateLimiter } = require('../../middleware/shareToken.middleware');

const router = express.Router();
const requireOwnDriver = (req, res, next) => {
    if (req.driverId !== req.params.id) {
        return res.status(403).json({ message: 'You are not authorized to access this driver resource' });
    }
    return next();
};

// Configure multer for document uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/driverDocuments/'); // Directory to save driver documents
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`); // Unique file name
    },
});

const upload = multer({ storage });

// Routes for driver management
router.post('/', addDriver); // Add a new driver with documents
router.post('/login', loginDriver); // Login driver
router.get('/', getAllDrivers); // Get all drivers
router.get('/:id', getDriverById); // Get a driver by ID
router.delete('/:id', deleteDriver); // Delete a driver by ID
router.put('/:id', updateDriver); // Update a driver with optional new documents

// Route to add documents to a driver's documents array
router.post('/:id/documents', upload.array('documents', 10), addDriverDocuments);

// Route to update a driver's documents
router.put('/:id/documents', upload.array('documents', 10), updateDriverDocuments);

// Route to fetch a driver's documents
router.get('/:id/documents', getDriverDocuments);

// Upload priority document
router.post('/:id/priority-document', upload.single('document'),uploadPriorityDocument);

// Route to get all rides of a driver
router.get('/:id/rides', getAllRidesOfDriver);

// Route to get upcoming scheduled bookings for a driver
router.get('/:id/upcoming-bookings', getUpcomingBookings);

// Route to update a driver's location
router.patch('/:id/location', updateDriverLocation);

// Route to update driver online/offline status
router.patch('/:id/online-status', updateDriverOnlineStatus);
router.post('/:id/logout', logoutDriver);
router.get('/:id/online-hours', getDriverOnlineHours);
router.put('/:id/compliance-documents', updateDriverComplianceDocuments);
router.post('/:id/live-location/share', authenticateDriver, requireOwnDriver, createDriverLocationShare);
router.get('/:id/live-location/shares', authenticateDriver, requireOwnDriver, listDriverLocationShares);
router.delete('/:id/live-location/share/:shareId', authenticateDriver, requireOwnDriver, deleteDriverLocationShare);
router.get('/live-location/shared/:shareToken', sharedLiveLocationRateLimiter, getSharedDriverLocation);

// Route to update driver vehicle information
router.patch('/:id/vehicle', updateDriverVehicle);

// Route to update driver busy status
router.patch('/:id/busy-status', updateDriverBusyStatus);

// Route to get driver statistics
router.get('/:id/stats', getDriverStats);

// Route to get nearby drivers
// Query params: longitude, latitude, maxDistance (optional, default 10000 meters)
router.get('/nearby', getNearbyDrivers);

// Route to mark cash as collected for a ride
router.patch('/:driverId/rides/:rideId/mark-cash-collected', markCashCollected);

module.exports = router;
