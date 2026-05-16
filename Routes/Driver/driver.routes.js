const express = require('express');
const fs = require('fs');
const multer = require('multer');
const AppError = require('../../utils/errors/AppError');
const { DRIVER_PROFILE_PIC_SUBDIR } = require('../../utils/driverProfilePic.service.js');
const {
    addDriver,
    registerDriver,
    patchDriverProfilePhoto,
    deleteDriverProfilePhoto,
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
    upsertDriverGoToHome,
    activateDriverGoTo,
    deactivateDriverGoTo,
    getDriverGoToStatus,
    updateDriverOnlineStatus,
    logoutDriver,
    updateDriverVehicle,
    deleteDriverVehicle,
    deleteDriverGarageVehicle,
    restoreGarageVehicleFromArchive,
    setDriverActiveOwnedVehicle,
    getDriverStats,
    getNearbyDrivers,
    updateDriverBusyStatus,
    updateDriverIntercityToggle,
    getUpcomingBookings,
    acceptRide,
    rejectAcceptedRide,
    markCashCollected,
    uploadPriorityDocument,
    getDriverOnlineHours,
    updateDriverComplianceDocuments,
    resubmitDriverApproval,
    createDriverLocationShare,
    listDriverLocationShares,
    deleteDriverLocationShare,
    getSharedDriverLocation
} = require('../../Controllers/Driver/driver.controller.js');
const vendorController = require('../../Controllers/Vendor/vendor.controller.js');
const {
    reportPaymentIssue,
    uploadDisputeEvidence,
    confirmPaymentReceived,
    listDriverDisputes,
} = require('../../Controllers/Driver/paymentDispute.controller.js');
const { authenticateDriver } = require('../../utils/driverAuth');
const { sharedLiveLocationRateLimiter } = require('../../middleware/shareToken.middleware');

const router = express.Router();
const requireOwnDriver = (req, res, next) => {
    if (req.driverId !== req.params.id) {
        return next(new AppError('You are not authorized to access this driver resource', 403, {
            code: 'DRIVER_RESOURCE_FORBIDDEN',
        }));
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

// General multer configuration with file size limits
const upload = multer({ 
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5 MB per file (reasonable for documents)
        files: 10, // Max 10 files per request
    },
});

// Vehicle document upload: 4 required documents (RC, Insurance, Permit, PUC)
// Each limited to 5MB
const vehicleDocumentUpload = upload.fields([
    { name: 'vehicleRc', maxCount: 1 },
    { name: 'vehicleInsurance', maxCount: 1 },
    { name: 'vehiclePermit', maxCount: 1 },
    { name: 'vehiclePuc', maxCount: 1 },
]);

/** Identity docs: field names map to types on the server (no client-provided names). */
const driverIdentityUpload = upload.fields([
    { name: 'aadhaarCard', maxCount: 1 },
    { name: 'panCard', maxCount: 1 },
    { name: 'drivingLicense', maxCount: 1 },
    { name: 'documents', maxCount: 10 },
]);

const driverProfilePicStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(DRIVER_PROFILE_PIC_SUBDIR, { recursive: true });
        cb(null, DRIVER_PROFILE_PIC_SUBDIR);
    },
    filename: (req, file, cb) => {
        const safe = String(file.originalname || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safe}`);
    },
});

const driverProfilePicUpload = multer({
    storage: driverProfilePicStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
        if (!ok) {
            return cb(new AppError('Only JPEG, PNG, or WebP images are allowed', 400, {
                code: 'INVALID_PROFILE_PIC_TYPE',
            }));
        }
        cb(null, true);
    },
});

// Routes for driver management
router.post('/me/leave-vendor', authenticateDriver, vendorController.leaveVendorAsDriver);
router.post('/register', driverProfilePicUpload.single('profilePic'), registerDriver);
router.post('/', addDriver); // Add a new driver (JSON)
router.post('/me/unassign-fleet', authenticateDriver, vendorController.unassignFleetVehicleAsDriver);
router.post('/', addDriver); // Add a new driver with documents
router.post('/login', loginDriver); // Login driver
router.get('/', getAllDrivers); // Get all drivers
router.get('/:id', getDriverById); // Get a driver by ID
router.delete('/:id', deleteDriver); // Delete a driver by ID
router.put('/:id', updateDriver); // Update a driver with optional new documents

router.patch(
    '/:id/profile-photo',
    authenticateDriver,
    requireOwnDriver,
    driverProfilePicUpload.single('profilePic'),
    patchDriverProfilePhoto
);
router.delete(
    '/:id/profile-photo',
    authenticateDriver,
    requireOwnDriver,
    deleteDriverProfilePhoto
);

// Route to add documents to a driver's documents array
router.post('/:id/documents', driverIdentityUpload, addDriverDocuments);

// Route to update a driver's documents
router.put('/:id/documents', driverIdentityUpload, updateDriverDocuments);

// Route to fetch a driver's documents
router.get('/:id/documents', getDriverDocuments);

// Upload priority document
router.post('/:id/priority-document', upload.single('document'),uploadPriorityDocument);

// Route to get all rides of a driver
router.get('/:id/rides', getAllRidesOfDriver);

// Route to get upcoming scheduled bookings for a driver
router.get('/:id/upcoming-bookings', getUpcomingBookings);

// Route for a driver to accept a ride (for push notification-based rides)
router.post(
    '/:driverId/rides/:rideId/accept',
    acceptRide
);

// Route for a driver to reject an accidentally accepted ride before start
router.patch(
    '/:driverId/rides/:rideId/reject-accepted',
    authenticateDriver,
    (req, res, next) => {
        if (req.driverId !== req.params.driverId) {
            return next(new AppError('You are not authorized to reject this ride', 403, {
                code: 'RIDE_REJECTION_FORBIDDEN',
            }));
        }
        return next();
    },
    rejectAcceptedRide
);

// Route to update a driver's location (authenticated driver only)
router.patch(
    '/:id/location',
    authenticateDriver,
    requireOwnDriver,
    updateDriverLocation
);
router.put(
    '/:id/go-to/home',
    authenticateDriver,
    requireOwnDriver,
    upsertDriverGoToHome
);
router.get(
    '/:id/go-to',
    authenticateDriver,
    requireOwnDriver,
    getDriverGoToStatus
);
router.post(
    '/:id/go-to/activate',
    authenticateDriver,
    requireOwnDriver,
    activateDriverGoTo
);
router.post(
    '/:id/go-to/deactivate',
    authenticateDriver,
    requireOwnDriver,
    deactivateDriverGoTo
);

// Route to update driver online/offline status (driver JWT only)
router.patch(
    '/:id/online-status',
    authenticateDriver,
    requireOwnDriver,
    updateDriverOnlineStatus
);
router.post('/:id/logout', logoutDriver);
router.get('/:id/online-hours', getDriverOnlineHours);
router.put('/:id/compliance-documents', updateDriverComplianceDocuments);
router.post(
    '/:id/resubmit-approval',
    authenticateDriver,
    requireOwnDriver,
    resubmitDriverApproval
);
router.post('/:id/live-location/share', authenticateDriver, requireOwnDriver, createDriverLocationShare);
router.get('/:id/live-location/shares', authenticateDriver, requireOwnDriver, listDriverLocationShares);
router.delete('/:id/live-location/share/:shareId', authenticateDriver, requireOwnDriver, deleteDriverLocationShare);
router.get('/live-location/shared/:shareToken', sharedLiveLocationRateLimiter, getSharedDriverLocation);

// Owned-vehicle garage: set active approved vehicle (self drivers)
router.patch(
    '/:id/vehicles/active',
    authenticateDriver,
    requireOwnDriver,
    setDriverActiveOwnedVehicle
);
router.delete(
    '/:id/vehicles/:vehicleId',
    authenticateDriver,
    requireOwnDriver,
    deleteDriverGarageVehicle
);
router.post(
    '/:id/vehicles/restore',
    authenticateDriver,
    requireOwnDriver,
    restoreGarageVehicleFromArchive
);

// Route to update driver vehicle information (submit new vehicle for approval)
router.patch(
    '/:id/vehicle',
    authenticateDriver,
    requireOwnDriver,
    vehicleDocumentUpload,
    updateDriverVehicle
);
router.delete(
    '/:id/vehicle',
    authenticateDriver,
    requireOwnDriver,
    deleteDriverVehicle
);

// Route to update driver busy status
router.patch('/:id/busy-status', updateDriverBusyStatus);
router.patch('/:id/intercity-toggle', updateDriverIntercityToggle);

// Route to get driver statistics
router.get('/:id/stats', getDriverStats);

// Route to get nearby drivers
// Query params: longitude, latitude, maxDistance (optional, default 10000 meters)
router.get('/nearby', getNearbyDrivers);

// Route to mark cash as collected for a ride
router.patch('/:driverId/rides/:rideId/mark-cash-collected', markCashCollected);

const disputeEvidenceStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) =>
        cb(null, `dispute-${Date.now()}-${file.originalname}`),
});
const disputeUpload = multer({
    storage: disputeEvidenceStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
});

router.post(
    '/:driverId/rides/:rideId/payment-disputes',
    disputeUpload.single('file'),
    reportPaymentIssue
);
router.post(
    '/:driverId/payment-disputes/:disputeId/evidence',
    disputeUpload.single('file'),
    uploadDisputeEvidence
);
router.patch(
    '/:driverId/payment-disputes/:disputeId/confirm-received',
    confirmPaymentReceived
);
router.get('/:driverId/payment-disputes', listDriverDisputes);

// Multer error handler for file upload errors (must be after all routes)
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        return next(error);
    }
    // If it's not a multer error, pass to next handler
    next(error);
});

module.exports = router;
