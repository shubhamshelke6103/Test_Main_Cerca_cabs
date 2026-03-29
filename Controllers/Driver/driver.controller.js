const Driver = require('../../Models/Driver/driver.model.js');
const Ride = require('../../Models/Driver/ride.model.js');
const Vendor = require('../../Models/vendor/vendor.models.js');
const bcrypt = require("bcryptjs");
const jwt = require('jsonwebtoken');
const logger = require('../../utils/logger.js');
const LiveLocationShare = require('../../Models/Shared/liveLocationShare.model.js');
const {
    createLiveLocationShare,
    revokeLiveLocationShare,
    getSharedLiveLocationPayload,
} = require('../../utils/liveLocationShare.service.js');
const {
    startDriverOnlineSession,
    stopDriverOnlineSession,
    getDriverOnlineHoursSummary,
} = require('../../utils/driverSession.service.js');
const { syncComplianceStatuses } = require('../../utils/compliance.service.js');
const {
    DEFAULT_CORRIDOR_RADIUS_METERS,
    buildGoToRouteSnapshot,
    deactivateGoToState,
    normalizeGeoPoint,
    normalizeLocationCoordinates,
    sanitizeGoToResponse,
} = require('../../utils/goToRoute.service.js');
const { persistDriverLocationWithGoTo } = require('../../utils/driverLocationPersistence.js');
const {
    buildInitialApprovalWorkflow,
    getDriverApprovalSummary,
    setDriverPendingApproval,
    DRIVER_APPROVAL_STATUS,
} = require('../../utils/driverApproval.service.js');

const buildDateRange = (period, startDate, endDate) => {
    const now = new Date();
    if (startDate || endDate) {
        return {
            start: startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1),
            end: endDate ? new Date(endDate) : now,
            groupBy: period || 'daily',
        };
    }

    if (period === 'monthly') {
        return {
            start: new Date(now.getFullYear(), 0, 1),
            end: now,
            groupBy: 'monthly',
        };
    }

    if (period === 'weekly') {
        return {
            start: new Date(now.getTime() - 84 * 24 * 60 * 60 * 1000),
            end: now,
            groupBy: 'weekly',
        };
    }

    return {
        start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        end: now,
        groupBy: 'daily',
    };
};

const getDriverOr404 = async (driverId, res) => {
    const driver = await Driver.findById(driverId);

    if (!driver) {
        res.status(404).json({ message: 'Driver not found' });
        return null;
    }

    return driver;
};

const resolveHomeLocationPayload = (body = {}, driver = null) => {
    const locationInput =
        body.homeLocation ||
        (body.homeCoordinates ? { coordinates: body.homeCoordinates } : null) ||
        (body.coordinates ? { coordinates: body.coordinates } : null) ||
        driver?.goTo?.homeLocation ||
        null;

    const normalizedLocation = normalizeGeoPoint(locationInput);

    return {
        homeAddress:
            typeof body.homeAddress === 'string'
                ? body.homeAddress.trim()
                : driver?.goTo?.homeAddress || '',
        homeLocation: normalizedLocation,
        corridorRadiusMeters:
            typeof body.corridorRadiusMeters === 'number' &&
            body.corridorRadiusMeters > 0
                ? body.corridorRadiusMeters
                : driver?.goTo?.corridorRadiusMeters || DEFAULT_CORRIDOR_RADIUS_METERS,
    };
};

const VEHICLE_DOCUMENT_FIELDS = [
    { field: 'vehicleRc', type: 'RC' },
    { field: 'vehicleInsurance', type: 'INSURANCE' },
    { field: 'vehiclePermit', type: 'PERMIT' },
    { field: 'vehiclePuc', type: 'PUC' },
];

const buildUploadedFileUrl = (req, file) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const normalizedPath = String(file.path || '').replace(/\\/g, '/');
    return `${baseUrl}/${normalizedPath}`;
};

const collectVehicleDocuments = (req) => {
    const uploadedFields = req.files || {};
    const missingFields = VEHICLE_DOCUMENT_FIELDS
        .filter(({ field }) => !uploadedFields[field] || !uploadedFields[field][0])
        .map(({ field }) => field);

    if (missingFields.length > 0) {
        return {
            missingFields,
            documents: [],
        };
    }

    const documents = VEHICLE_DOCUMENT_FIELDS.map(({ field, type }) => ({
        documentType: type,
        documentUrl: buildUploadedFileUrl(req, uploadedFields[field][0]),
    }));

    return {
        missingFields: [],
        documents,
    };
};

const serializeVehicleState = (driver) => ({
    approvedVehicle: driver.vehicleInfo || null,
    pendingVehicle: driver.pendingVehicleInfo || null,
    vehicleStatus: driver.pendingVehicleInfo?.approvalStatus || (driver.vehicleInfo ? 'APPROVED' : 'NOT_ADDED'),
});

const serializeDriverApprovalState = (driver) => ({
    approvalStatus: getDriverApprovalSummary(driver).status,
    approvalWorkflow: getDriverApprovalSummary(driver),
});

const approvePendingVehicleForDriver = async (driver, approvedBy = 'ADMIN') => {
    if (!driver.pendingVehicleInfo) {
        throw new Error('No pending vehicle found');
    }

    const approvedVehicle = {
        make: driver.pendingVehicleInfo.make,
        model: driver.pendingVehicleInfo.model,
        year: driver.pendingVehicleInfo.year,
        color: driver.pendingVehicleInfo.color,
        licensePlate: driver.pendingVehicleInfo.licensePlate,
        vehicleType: driver.pendingVehicleInfo.vehicleType,
    };

    driver.vehicleInfo = approvedVehicle;
    driver.pendingVehicleInfo = {
        ...driver.pendingVehicleInfo.toObject(),
        approvalStatus: 'APPROVED',
        approvedAt: new Date(),
        rejectedAt: null,
        rejectionReason: null,
        approvedBy,
    };

    await driver.save();

    driver.pendingVehicleInfo = null;
    await driver.save();

    return driver;
};

const rejectPendingVehicleForDriver = async (driver, reason) => {
    if (!driver.pendingVehicleInfo) {
        throw new Error('No pending vehicle found');
    }

    driver.pendingVehicleInfo = {
        ...driver.pendingVehicleInfo.toObject(),
        approvalStatus: 'REJECTED',
        rejectedAt: new Date(),
        approvedAt: null,
        rejectionReason: reason,
    };

    await driver.save();
    return driver;
};

/**
 * @desc    Add a new driver
 * @route   POST /drivers
 */
const addDriver = async (req, res) => {
    try {
        const { name, email, phone, password, location } = req.body;

        console.log('Received driver data:');
        console.log(req.body);
        
        let driver = await Driver.findOne({ phone });
        if (driver) {
            return res.status(400).json({ message: 'Driver with this phone number already exists' });
        }
        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create a new driver
        const driverObj = new Driver({
            name,
            email,
            phone,
            password: hashedPassword,
            location,
            documents: [], // Initialize with an empty array
            approvalWorkflow: buildInitialApprovalWorkflow(null),
        });

        await driverObj.save();

        logger.info(`Driver added successfully: ${driverObj.email}`);
        res.status(201).json({ id: driverObj, message: 'Driver added successfully' });
    } catch (error) {
        logger.error('Error adding driver:', error);
        res.status(400).json({ message: 'Error adding driver', error });
    }
};

/**
 * @desc    Add documents to a driver's documents array
 * @route   POST /drivers/:id/documents
 */
const addDriverDocuments = async (req, res) => {
    try {
        const driverId = req.params.id;

        // Check if files are uploaded
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded' });
        }

        // Generate complete URLs for the uploaded documents
        const documentPaths = req.files.map((file) => {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            return `${baseUrl}/${file.path}`;
        });

        // Find the driver and update the documents array
        const driver = await Driver.findById(driverId);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        driver.documents.push(...documentPaths);
        driver.rejectionReason = null;
        await driver.save();

        logger.info(`Documents added to driver: ${driver.email}`);
        res.status(200).json({ message: 'Documents added successfully', documents: driver.documents });
    } catch (error) {
        logger.error('Error adding documents to driver:', error);
        res.status(500).json({ message: 'Error adding documents to driver', error });
    }
};

/**
 * @desc    Login driver by email and password
 * @route   POST /drivers/login
 */
const loginDriver = async (req, res) => {
    const { email, password } = req.body;

    try {
        const driver = await Driver.findOne({ email });

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, driver.password);

        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Generate JWT token
        const token = jwt.sign(
            { id: driver._id, email: driver.email },
            "@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%",
            { expiresIn: '7d' }
        );

        await startDriverOnlineSession(driver._id, 'login');

        logger.info(`Driver logged in: ${driver.email}`);
        res.status(200).json({ message: 'Login successful', token, id:driver._id });
    } catch (error) {
        logger.error('Error during driver login:', error);
        res.status(500).json({ message: 'An error occurred during login', error });
    }
};

/**
 * @desc    Get all drivers
 * @route   GET /drivers
 */
const getAllDrivers = async (req, res) => {
    try {
        const drivers = await Driver.find();
        res.status(200).json(drivers);
    } catch (error) {
        logger.error('Error fetching drivers:', error);
        res.status(500).json({ message: 'Error fetching drivers', error });
    }
};

/**
 * @desc    Get a driver by ID
 * @route   GET /drivers/:id
 */
const getDriverById = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }
        
        // Compute total earnings from AdminEarnings
        const AdminEarnings = require('../../Models/Admin/adminEarnings.model');
        const earningsResult = await AdminEarnings.aggregate([
            { $match: { driverId: driver._id } },
            { $group: { _id: null, totalEarnings: { $sum: '$driverEarning' } } }
        ]);
        const totalEarnings = earningsResult.length > 0 ? earningsResult[0].totalEarnings : 0;
        
        // Compute total completed rides
        const Ride = require('../../Models/Driver/ride.model');
        const totalRides = await Ride.countDocuments({ 
            driver: driver._id, 
            status: 'completed' 
        });
        
        // Convert driver to plain object and add computed fields
        const driverObj = driver.toObject();
        driverObj.totalEarnings = Math.round(totalEarnings * 100) / 100; // Round to 2 decimal places
        driverObj.completedRidesCount = totalRides;
        delete driverObj.password;
        driverObj.rejectionReason = driver.rejectionReason ?? null;
        driverObj.vehicleStatus =
            driver.pendingVehicleInfo?.approvalStatus || (driver.vehicleInfo ? 'APPROVED' : 'NOT_ADDED');
        Object.assign(driverObj, serializeDriverApprovalState(driver));

        res.status(200).json(driverObj);
    } catch (error) {
        logger.error('Error fetching driver:', error);
        res.status(500).json({ message: 'Error fetching driver', error });
    }
};

/**
 * @desc    Delete a driver by ID
 * @route   DELETE /drivers/:id
 */
const deleteDriver = async (req, res) => {
    try {
        const driver = await Driver.findByIdAndDelete(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        logger.info(`Driver deleted successfully: ${driver.email}`);
        res.status(200).json({ message: 'Driver deleted successfully' });
    } catch (error) {
        logger.error('Error deleting driver:', error);
        res.status(500).json({ message: 'Error deleting driver', error });
    }
};

/**
 * @desc    Update a driver by ID
 * @route   PUT /drivers/:id
 */
const updateDriver = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (Array.isArray(req.body?.trustedContacts) && req.body.trustedContacts.length > 5) {
            return res.status(400).json({ message: 'Driver can add up to 5 emergency contacts only' });
        }

        if (req.body.vendorId !== undefined && !driver.isVerified && req.body.approvalWorkflow === undefined) {
            req.body.approvalWorkflow = buildInitialApprovalWorkflow(req.body.vendorId || null);
        }

        // Update the driver with the new data (excluding files)
        const updatedDriver = await Driver.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        });

        logger.info(`Driver updated successfully: ${updatedDriver.email}`);
        res.status(200).json({
            ...updatedDriver.toObject(),
            ...serializeDriverApprovalState(updatedDriver),
        });
    } catch (error) {
        logger.error('Error updating driver:', error);
        res.status(400).json({ message: 'Error updating driver', error });
    }
};

/**
 * @desc    Update a driver's documents
 * @route   PUT /drivers/:id/documents
 */
const updateDriverDocuments = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        // Check if new documents are uploaded
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded' });
        }

        // Delete previous files
        const fs = require('fs');
        driver.documents.forEach((filePath) => {
            const fullPath = filePath.replace(`${req.protocol}://${req.get('host')}/`, '');
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        });

        // Generate complete URLs for the new documents
        const documentPaths = req.files.map((file) => {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            return `${baseUrl}/${file.path}`;
        });

        // Update the driver's documents array
        driver.documents = documentPaths;
        await driver.save();

        logger.info(`Driver documents updated successfully: ${driver.email}`);
        res.status(200).json({ message: 'Driver documents updated successfully', documents: driver.documents });
    } catch (error) {
        logger.error('Error updating driver documents:', error);
        res.status(500).json({ message: 'Error updating driver documents', error });
    }
};

const uploadPriorityDocument = async (req, res) => {
    try {
        const driverId = req.params.id;

        if (!req.file) {
            return res.status(400).json({ message: "No document uploaded" });
        }

        const driver = await Driver.findById(driverId);
        if (!driver) {
            return res.status(404).json({ message: "Driver not found" });
        }

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const documentUrl = `${baseUrl}/${req.file.path}`;

        driver.priorityDocument = documentUrl;
        driver.isPriorityDriver = false;      // Reset until approved
        driver.priorityApprovedAt = null;     // Reset approval time

        await driver.save();

        res.status(200).json({
            message: "Priority document uploaded. Waiting for admin approval."
        });

    } catch (error) {
        res.status(500).json({
            message: "Error uploading priority document",
            error: error.message
        });
    }
};

const approvePriorityDriver = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: "Driver not found" });
        }

        if (!driver.priorityDocument) {
            return res.status(400).json({
                message: "No priority document uploaded"
            });
        }

        driver.isPriorityDriver = true;
        driver.priorityApprovedAt = new Date();

        await driver.save();

        res.status(200).json({
            message: "Driver upgraded to PRIORITY successfully"
        });

    } catch (error) {
        res.status(500).json({
            message: "Error approving driver",
            error: error.message
        });
    }
};

/**
 * @desc    Reject priority driver application (clears document so driver can re-apply)
 * @route   PUT /admin/drivers/:id/reject-priority
 */
const rejectPriorityDriver = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: "Driver not found" });
        }

        driver.priorityDocument = null;
        driver.isPriorityDriver = false;
        driver.priorityApprovedAt = null;

        await driver.save();

        res.status(200).json({
            message: "Priority application rejected. Driver can re-apply."
        });

    } catch (error) {
        res.status(500).json({
            message: "Error rejecting priority driver",
            error: error.message
        });
    }
};

/**
 * @desc    Update the isActive status of a driver
 * @route   PATCH /drivers/:id/isActive
 */
const updateDriverIsReadyForRides = async (req, res) => {
    try {
        const { isActive } = req.body;

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ message: 'isActive must be a boolean value' });
        }

        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        driver.isActive = isActive;
        await driver.save();

        logger.info(`Driver isActive status updated: ${driver.email}, isActive: ${isActive}`);
        res.status(200).json({ message: 'Driver isActive status updated successfully', driver });
    } catch (error) {
        logger.error('Error updating driver isActive status:', error);
        res.status(500).json({ message: 'Error updating driver isActive status', error });
    }
};

/**
 * @desc    Get all rides of a driver
 * @route   GET /drivers/:id/rides
 */
const getAllRidesOfDriver = async (req, res) => {
    try {
        // Check if driver exists
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        // Query Ride model directly for all rides with this driver
        const rides = await Ride.find({ driver: req.params.id })
            .populate('rider', 'fullName email phoneNumber profilePic')
            .sort({ createdAt: -1 }); // Most recent first

        if(rides.length === 0) {
            return res.status(200).json({ message: 'No rides found for this driver', rides: [] });
        }
        
        // Sort rides by status priority: active statuses first, then completed/cancelled
        // Status priority: in_progress > accepted > requested > completed > cancelled
        const statusPriority = {
            'in_progress': 1,
            'accepted': 2,
            'requested': 3,
            'completed': 4,
            'cancelled': 5
        };
        
        const sortedRides = rides.sort((a, b) => {
            const priorityA = statusPriority[a.status] || 99;
            const priorityB = statusPriority[b.status] || 99;
            
            // If same status, sort by most recent first
            if (priorityA === priorityB) {
                return new Date(b.createdAt) - new Date(a.createdAt);
            }
            
            return priorityA - priorityB;
        });
        
        res.status(200).json({ rides: sortedRides });
    } catch (error) {
        logger.error('Error fetching rides of driver:', error);
        res.status(500).json({ message: 'Error fetching rides of driver', error });
    }
};

/**
 * @desc    Get upcoming scheduled bookings for a driver
 * @route   GET /drivers/:id/upcoming-bookings
 */
const getUpcomingBookings = async (req, res) => {
    try {
        const { getUpcomingBookingsForDriver } = require('../../utils/ride_booking_functions');
        
        // Check if driver exists
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        // Get upcoming bookings
        const upcomingBookings = await getUpcomingBookingsForDriver(req.params.id);

        res.status(200).json({
            message: 'Upcoming bookings retrieved successfully',
            bookings: upcomingBookings,
            count: upcomingBookings.length
        });
    } catch (error) {
        logger.error('Error fetching upcoming bookings:', error);
        res.status(500).json({ message: 'Error fetching upcoming bookings', error: error.message });
    }
};

/**
 * @desc    Update the location of a driver
 * @route   PATCH /drivers/:id/location
 */
const updateDriverLocation = async (req, res) => {
    try {
        const { coordinates } = req.body;

        if (!Array.isArray(coordinates) || coordinates.length !== 2) {
            return res.status(400).json({ message: 'Invalid coordinates. Must be an array of [longitude, latitude].' });
        }

        const longitude = parseFloat(coordinates[0]);
        const latitude = parseFloat(coordinates[1]);

        if (Number.isNaN(longitude) || Number.isNaN(latitude)) {
            return res.status(400).json({ message: 'Invalid coordinates. Longitude and latitude must be numbers.' });
        }

        if (
            longitude < -180 ||
            longitude > 180 ||
            latitude < -90 ||
            latitude > 90
        ) {
            return res.status(400).json({
                message: 'Coordinates out of range. Longitude: -180 to 180, Latitude: -90 to 90',
            });
        }

        const { driver, goToRouteRefreshed } = await persistDriverLocationWithGoTo(
            req.params.id,
            longitude,
            latitude
        );

        res.status(200).json({
            message: 'Driver location updated successfully',
            location: driver.location,
            goTo: sanitizeGoToResponse(driver.goTo),
            goToRouteRefreshed,
        });
    } catch (error) {
        if (error.message === 'Driver not found') {
            return res.status(404).json({ message: 'Driver not found' });
        }
        logger.error('Error updating driver location:', error);
        res.status(500).json({ message: 'Error updating driver location', error });
    }
};

/**
 * @desc    Save or update a driver's GO TO home destination
 * @route   PUT /drivers/:id/go-to/home
 */
const upsertDriverGoToHome = async (req, res) => {
    try {
        const driver = await getDriverOr404(req.params.id, res);
        if (!driver) return;

        const { homeAddress, homeLocation, corridorRadiusMeters } =
            resolveHomeLocationPayload(req.body, driver);
        const currentGoTo = driver.goTo?.toObject?.() || driver.goTo || {};

        driver.goTo = {
            ...currentGoTo,
            homeAddress,
            homeLocation,
            corridorRadiusMeters,
        };

        await driver.save();

        res.status(200).json({
            message: 'Driver GO TO home destination updated successfully',
            goTo: sanitizeGoToResponse(driver.goTo),
        });
    } catch (error) {
        logger.error('Error updating GO TO home destination:', error);
        res.status(400).json({
            message: 'Error updating GO TO home destination',
            error: error.message,
        });
    }
};

/**
 * @desc    Activate GO TO mode for a driver
 * @route   POST /drivers/:id/go-to/activate
 */
const activateDriverGoTo = async (req, res) => {
    try {
        const driver = await getDriverOr404(req.params.id, res);
        if (!driver) return;

        const originCoordinates = normalizeLocationCoordinates(driver.location);
        const { homeAddress, homeLocation, corridorRadiusMeters } =
            resolveHomeLocationPayload(req.body, driver);

        driver.goTo = await buildGoToRouteSnapshot({
            origin: { coordinates: originCoordinates },
            destination: homeLocation,
            homeAddress,
            corridorRadiusMeters,
        });

        await driver.save();

        res.status(200).json({
            message: 'GO TO activated successfully',
            goTo: sanitizeGoToResponse(driver.goTo),
        });
    } catch (error) {
        logger.error('Error activating GO TO:', error);
        res.status(400).json({
            message: 'Error activating GO TO',
            error: error.message,
        });
    }
};

/**
 * @desc    Deactivate GO TO mode for a driver
 * @route   POST /drivers/:id/go-to/deactivate
 */
const deactivateDriverGoTo = async (req, res) => {
    try {
        const driver = await getDriverOr404(req.params.id, res);
        if (!driver) return;

        driver.goTo = deactivateGoToState(driver.goTo?.toObject?.() || driver.goTo || {});
        await driver.save();

        res.status(200).json({
            message: 'GO TO deactivated successfully',
            goTo: sanitizeGoToResponse(driver.goTo),
        });
    } catch (error) {
        logger.error('Error deactivating GO TO:', error);
        res.status(500).json({
            message: 'Error deactivating GO TO',
            error: error.message,
        });
    }
};

/**
 * @desc    Get current GO TO state for a driver
 * @route   GET /drivers/:id/go-to
 */
const getDriverGoToStatus = async (req, res) => {
    try {
        const driver = await getDriverOr404(req.params.id, res);
        if (!driver) return;

        res.status(200).json({
            message: 'Driver GO TO status fetched successfully',
            goTo: sanitizeGoToResponse(driver.goTo),
        });
    } catch (error) {
        logger.error('Error fetching GO TO status:', error);
        res.status(500).json({
            message: 'Error fetching GO TO status',
            error: error.message,
        });
    }
};

/**
 * @desc    Update driver online/offline status
 * @route   PATCH /drivers/:id/online-status
 */
const updateDriverOnlineStatus = async (req, res) => {
    try {
        const { isOnline } = req.body;

        if (typeof isOnline !== 'boolean') {
            return res.status(400).json({ message: 'isOnline must be a boolean value' });
        }

        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const updatedDriver = isOnline
            ? await startDriverOnlineSession(driver._id, 'manual_toggle')
            : await stopDriverOnlineSession(driver._id, 'manual_toggle');

        logger.info(`Driver online status updated: ${driver.email}, isOnline: ${isOnline}`);
        res.status(200).json({ 
            message: 'Driver online status updated successfully', 
            driver: updatedDriver
        });
    } catch (error) {
        logger.error('Error updating driver online status:', error);
        res.status(500).json({ message: 'Error updating driver online status', error });
    }
};

const logoutDriver = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const updatedDriver = await stopDriverOnlineSession(driver._id, 'manual_toggle');

        res.status(200).json({
            message: 'Driver logged out successfully',
            driver: updatedDriver,
        });
    } catch (error) {
        logger.error('Error logging out driver:', error);
        res.status(500).json({ message: 'Error logging out driver', error: error.message });
    }
};

/**
 * @desc    Update driver vehicle information
 * @route   PATCH /drivers/:id/vehicle
 */
const updateDriverVehicle = async (req, res) => {
    try {
        const { make, model, year, color, licensePlate, vehicleType } = req.body;

        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (!make || !model || !year || !color || !licensePlate) {
            return res.status(400).json({
                message: 'make, model, year, color, and licensePlate are required',
            });
        }

        const { missingFields, documents } = collectVehicleDocuments(req);
        if (missingFields.length > 0) {
            return res.status(400).json({
                message: 'Vehicle RC, Insurance, Permit, and PUC documents are required',
                missingFields,
            });
        }

        driver.pendingVehicleInfo = {
            make,
            model,
            year: Number(year),
            color,
            licensePlate,
            vehicleType: vehicleType || 'sedan',
            documents,
            approvalStatus: 'UNDER_APPROVAL',
            approvalRoutedTo: driver.vendorId ? 'VENDOR' : 'ADMIN',
            submittedAt: new Date(),
            approvedAt: null,
            rejectedAt: null,
            rejectionReason: null,
        };

        await driver.save();

        logger.info(`Driver vehicle info updated: ${driver.email}`);
        res.status(200).json({ 
            message: `Vehicle submitted for ${driver.vendorId ? 'vendor' : 'admin'} approval successfully`,
            routedTo: driver.vendorId ? 'VENDOR' : 'ADMIN',
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error updating driver vehicle:', error);
        res.status(500).json({ message: 'Error updating driver vehicle information', error });
    }
};

const approveDriverVehicle = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (!driver.pendingVehicleInfo) {
            return res.status(400).json({ message: 'No pending vehicle approval found' });
        }

        if (driver.pendingVehicleInfo.approvalRoutedTo !== 'ADMIN') {
            return res.status(403).json({ message: 'This vehicle approval is routed to vendor' });
        }

        await approvePendingVehicleForDriver(driver, 'ADMIN');

        return res.status(200).json({
            message: 'Driver vehicle approved successfully',
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error approving driver vehicle:', error);
        return res.status(500).json({ message: 'Error approving driver vehicle', error: error.message });
    }
};

const rejectDriverVehicle = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);
        const reason = req.body?.reason;

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (!driver.pendingVehicleInfo) {
            return res.status(400).json({ message: 'No pending vehicle approval found' });
        }

        if (driver.pendingVehicleInfo.approvalRoutedTo !== 'ADMIN') {
            return res.status(403).json({ message: 'This vehicle approval is routed to vendor' });
        }

        if (typeof reason !== 'string' || !reason.trim()) {
            return res.status(400).json({ message: 'Rejection reason is required' });
        }

        await rejectPendingVehicleForDriver(driver, reason.trim());

        return res.status(200).json({
            message: 'Driver vehicle rejected successfully',
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error rejecting driver vehicle:', error);
        return res.status(500).json({ message: 'Error rejecting driver vehicle', error: error.message });
    }
};

/**
 * @desc    Get driver earnings
 * @route   GET /drivers/:id/earnings
 */
const getDriverEarnings = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        // Get settings for commission calculation
        const Settings = require('../../Models/Admin/settings.modal.js');
        const settings = await Settings.findOne();
        
        if (!settings) {
            return res.status(500).json({ message: 'Admin settings not found' });
        }

        const { platformFees, driverCommissions } = settings.pricingConfigurations;

        // Get completed rides
        const completedRides = await Ride.find({ 
            driver: req.params.id,
            status: 'completed'
        }).sort({ createdAt: -1 });

        // Calculate total gross earnings (total fare collected)
        const totalGrossEarnings = completedRides.reduce((sum, ride) => sum + (ride.fare || 0), 0);
        const totalRides = completedRides.length;

        logger.info(
          `[Fare Tracking] getDriverEarnings - driverId: ${req.params.id}, totalRides: ${totalRides}, totalGrossEarnings: ₹${totalGrossEarnings}, platformFees: ${platformFees}%, driverCommissions: ${driverCommissions}%`
        );

        // Calculate platform fees (amount platform takes)
        const totalPlatformFees = platformFees ? totalGrossEarnings * (platformFees / 100) : 0;

        // Calculate driver commission (percentage driver keeps)
        // If driverCommissions is 80%, driver gets 80% of fare
        const totalDriverEarnings = driverCommissions 
            ? totalGrossEarnings * (driverCommissions / 100) 
            : totalGrossEarnings - totalPlatformFees;

        // Calculate per ride averages
        const averageGrossPerRide = totalRides > 0 ? (totalGrossEarnings / totalRides).toFixed(2) : 0;
        const averageNetPerRide = totalRides > 0 ? (totalDriverEarnings / totalRides).toFixed(2) : 0;

        res.status(200).json({ 
            totalGrossEarnings, // Total fare collected from riders
            totalPlatformFees, // Amount deducted by platform
            totalDriverEarnings, // Net amount driver receives
            platformFeePercentage: platformFees || 0,
            driverCommissionPercentage: driverCommissions || 0,
            totalRides,
            averageGrossPerRide,
            averageNetPerRide,
            recentRides: completedRides.slice(0, 10).map(ride => ({
                _id: ride._id,
                fare: ride.fare,
                platformFee: platformFees ? (ride.fare * (platformFees / 100)).toFixed(2) : 0,
                driverEarning: driverCommissions 
                    ? (ride.fare * (driverCommissions / 100)).toFixed(2)
                    : (ride.fare - (ride.fare * (platformFees / 100))).toFixed(2),
                distanceInKm: ride.distanceInKm,
                actualDuration: ride.actualDuration,
                pickupAddress: ride.pickupAddress,
                dropoffAddress: ride.dropoffAddress,
                createdAt: ride.createdAt,
                completedAt: ride.actualEndTime,
            })),
        });
    } catch (error) {
        logger.error('Error fetching driver earnings:', error);
        res.status(500).json({ message: 'Error fetching driver earnings', error });
    }
};

/**
 * @desc    Get driver statistics
 * @route   GET /drivers/:id/stats
 */
const getDriverStats = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        // Get all rides
        const allRides = await Ride.find({ driver: req.params.id });

        const stats = {
            totalRides: allRides.length,
            completedRides: allRides.filter(r => r.status === 'completed').length,
            cancelledRides: allRides.filter(r => r.status === 'cancelled').length,
            inProgressRides: allRides.filter(r => r.status === 'in_progress').length,
            rating: driver.rating || 0,
            totalRatings: driver.totalRatings || 0,
            totalEarnings: driver.totalEarnings || 0,
            isOnline: driver.isOnline,
            isActive: driver.isActive,
            isBusy: driver.isBusy,
            lastSeen: driver.lastSeen,
            rideRejectionCount: driver.rideRejectionCount || 0,
            rideRejectionThreshold: driver.rideRejectionThreshold || 5,
            totalOnlineMinutes: driver.totalOnlineMinutes || 0,
        };

        res.status(200).json({ stats });
    } catch (error) {
        logger.error('Error fetching driver stats:', error);
        res.status(500).json({ message: 'Error fetching driver statistics', error });
    }
};

/**
 * @desc    Get nearby drivers
 * @route   GET /drivers/nearby
 */
const getNearbyDrivers = async (req, res) => {
    try {
        const { longitude, latitude, maxDistance = 10000 } = req.query; // maxDistance in meters

        if (!longitude || !latitude) {
            return res.status(400).json({ message: 'longitude and latitude are required' });
        }

        const drivers = await Driver.find({
            location: {
                $near: {
                    $geometry: {
                        type: 'Point',
                        coordinates: [parseFloat(longitude), parseFloat(latitude)],
                    },
                    $maxDistance: parseInt(maxDistance),
                },
            },
            isActive: true,
            isOnline: true,
            isBusy: false,
        }).select('-password -documents');

        res.status(200).json({ 
            drivers,
            count: drivers.length 
        });
    } catch (error) {
        logger.error('Error fetching nearby drivers:', error);
        res.status(500).json({ message: 'Error fetching nearby drivers', error });
    }
};

/**
 * @desc    Update driver busy status
 * @route   PATCH /drivers/:id/busy-status
 */
const updateDriverBusyStatus = async (req, res) => {
    try {
        const { isBusy } = req.body;

        if (typeof isBusy !== 'boolean') {
            return res.status(400).json({ message: 'isBusy must be a boolean value' });
        }

        const driver = await Driver.findByIdAndUpdate(
            req.params.id,
            { isBusy },
            { new: true }
        ).select('-password');

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        logger.info(`Driver busy status updated: ${driver.email}, isBusy: ${isBusy}`);
        res.status(200).json({ 
            message: 'Driver busy status updated successfully', 
            driver 
        });
    } catch (error) {
        logger.error('Error updating driver busy status:', error);
        res.status(500).json({ message: 'Error updating driver busy status', error });
    }
};

/**
 * @desc    Mark cash as collected for a ride
 * @route   PATCH /drivers/:driverId/rides/:rideId/mark-cash-collected
 */
const markCashCollected = async (req, res) => {
    try {
        const { driverId, rideId } = req.params;
        
        // Verify driver exists
        const driver = await Driver.findById(driverId);
        if (!driver) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found',
            });
        }
        
        // Verify ride exists and belongs to driver
        const ride = await Ride.findById(rideId);
        if (!ride) {
            return res.status(404).json({
                success: false,
                message: 'Ride not found',
            });
        }
        
        if (ride.driver.toString() !== driverId) {
            return res.status(403).json({
                success: false,
                message: 'Ride does not belong to this driver',
            });
        }
        
        // Check if ride is completed
        if (ride.status !== 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Ride must be completed before marking cash as collected',
            });
        }
        
        // Check if payment method is CASH
        if (ride.paymentMethod !== 'CASH') {
            return res.status(400).json({
                success: false,
                message: 'This endpoint is only for CASH payments',
            });
        }
        
        // Update ride payment status
        ride.paymentStatus = 'completed';
        await ride.save();
        
        // Update AdminEarnings payment status
        const AdminEarnings = require('../../Models/Admin/adminEarnings.model');
        const earning = await AdminEarnings.findOne({ rideId: rideId });
        if (earning) {
            earning.paymentStatus = 'completed';
            await earning.save();
        }
        
        logger.info(`Cash marked as collected for ride ${rideId} by driver ${driverId}`);
        
        res.status(200).json({
            success: true,
            message: 'Cash collection marked as completed',
            ride: {
                _id: ride._id,
                paymentStatus: ride.paymentStatus,
            },
        });
    } catch (error) {
        logger.error('Error marking cash as collected:', error);
        res.status(500).json({
            success: false,
            message: 'Error marking cash as collected',
            error: error.message,
        });
    }
};

// new helper: retrieve driver documents
const getDriverDocuments = async (req, res) => {
    try {
        const driverId = req.params.id;
        const driver = await Driver.findById(driverId).select('documents');
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }
        res.status(200).json({ documents: driver.documents || [] });
    } catch (error) {
        logger.error('Error fetching driver documents:', error);
        res.status(500).json({ message: 'Error fetching driver documents', error });
    }
};

const getDriverOnlineHours = async (req, res) => {
    try {
        const driverId = req.params.id;
        const driver = await Driver.findById(driverId).select('name totalOnlineMinutes currentOnlineSessionStartedAt');

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const { period, startDate, endDate } = req.query;
        const range = buildDateRange(period, startDate, endDate);
        const report = await getDriverOnlineHoursSummary(
            driverId,
            range.start,
            range.end,
            range.groupBy
        );

        res.status(200).json({
            success: true,
            driver: {
                id: driver._id,
                name: driver.name,
                totalOnlineMinutes: driver.totalOnlineMinutes || 0,
                currentOnlineSessionStartedAt: driver.currentOnlineSessionStartedAt,
            },
            report: {
                ...report,
                period: range.groupBy,
                startDate: range.start,
                endDate: range.end,
            },
        });
    } catch (error) {
        logger.error('Error fetching driver online hours:', error);
        res.status(500).json({ message: 'Error fetching driver online hours', error: error.message });
    }
};

const updateDriverComplianceDocuments = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const complianceDocuments = Array.isArray(req.body.complianceDocuments)
            ? req.body.complianceDocuments
            : [];

        driver.complianceDocuments = syncComplianceStatuses(complianceDocuments);
        await driver.save();

        res.status(200).json({
            success: true,
            message: 'Driver compliance documents updated successfully',
            complianceDocuments: driver.complianceDocuments,
        });
    } catch (error) {
        logger.error('Error updating driver compliance documents:', error);
        res.status(500).json({ message: 'Error updating driver compliance documents', error: error.message });
    }
};

/**
 * @desc    Driver resubmits after REJECTED — reset workflow to PENDING_VENDOR / PENDING_ADMIN
 * @route   POST /drivers/:id/resubmit-approval (authenticated, own id only)
 */
const resubmitDriverApproval = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const summary = getDriverApprovalSummary(driver);
        if (summary.status !== DRIVER_APPROVAL_STATUS.REJECTED) {
            return res.status(400).json({
                message: 'Resubmit is only available after your application was rejected',
                approvalStatus: summary.status,
            });
        }

        setDriverPendingApproval(driver);
        await driver.save();

        const AdminEarnings = require('../../Models/Admin/adminEarnings.model');
        const earningsResult = await AdminEarnings.aggregate([
            { $match: { driverId: driver._id } },
            { $group: { _id: null, totalEarnings: { $sum: '$driverEarning' } } },
        ]);
        const totalEarnings = earningsResult.length > 0 ? earningsResult[0].totalEarnings : 0;

        const totalRides = await Ride.countDocuments({
            driver: driver._id,
            status: 'completed',
        });

        const driverObj = driver.toObject();
        driverObj.totalEarnings = Math.round(totalEarnings * 100) / 100;
        driverObj.completedRidesCount = totalRides;
        delete driverObj.password;
        driverObj.rejectionReason = driver.rejectionReason ?? null;
        driverObj.vehicleStatus =
            driver.pendingVehicleInfo?.approvalStatus ||
            (driver.vehicleInfo ? 'APPROVED' : 'NOT_ADDED');
        Object.assign(driverObj, serializeDriverApprovalState(driver));

        res.status(200).json(driverObj);
    } catch (error) {
        logger.error('Error resubmitting driver approval:', error);
        res.status(500).json({ message: 'Error resubmitting for approval', error: error.message });
    }
};

const createDriverLocationShare = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id).select('name vendorId');
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        let {
            recipientName,
            recipientPhone,
            recipientEmail,
            recipientType,
            relation,
            durationMinutes,
        } = req.body;

        if (recipientType === 'vendor') {
            if (!driver.vendorId) {
                return res.status(400).json({ message: 'Driver is not assigned to any vendor' });
            }

            const vendor = await Vendor.findById(driver.vendorId).select('businessName email phone');
            if (!vendor) {
                return res.status(404).json({ message: 'Assigned vendor not found' });
            }

            recipientName = vendor.businessName;
            recipientPhone = vendor.phone || recipientPhone || null;
            recipientEmail = vendor.email || recipientEmail || null;
            relation = relation || 'assigned_vendor';
        }

        if (!recipientName) {
            return res.status(400).json({ message: 'recipientName is required' });
        }

        const share = await createLiveLocationShare({
            ownerId: driver._id,
            ownerModel: 'Driver',
            recipientName,
            recipientPhone,
            recipientEmail,
            recipientType,
            relation,
            durationMinutes: durationMinutes || 120,
        });

        const baseUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;

        res.status(201).json({
            success: true,
            message: 'Driver live location share created successfully',
            share: {
                id: share._id,
                recipientName: share.recipientName,
                recipientType: share.recipientType,
                relation: share.relation,
                expiresAt: share.expiresAt,
                shareUrl: `${baseUrl}/drivers/live-location/shared/${share.shareToken}`,
            },
        });
    } catch (error) {
        logger.error('Error creating driver live location share:', error);
        res.status(500).json({ message: 'Error creating driver live location share', error: error.message });
    }
};

const listDriverLocationShares = async (req, res) => {
    try {
        const shares = await LiveLocationShare.find({
            owner: req.params.id,
            ownerModel: 'Driver',
        }).sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            shares,
        });
    } catch (error) {
        logger.error('Error listing driver live location shares:', error);
        res.status(500).json({ message: 'Error listing driver live location shares', error: error.message });
    }
};

const deleteDriverLocationShare = async (req, res) => {
    try {
        const share = await revokeLiveLocationShare(req.params.shareId, req.params.id);
        if (!share) {
            return res.status(404).json({ message: 'Share not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Driver live location share revoked successfully',
            share,
        });
    } catch (error) {
        logger.error('Error revoking driver live location share:', error);
        res.status(500).json({ message: 'Error revoking driver live location share', error: error.message });
    }
};

const getSharedDriverLocation = async (req, res) => {
    try {
        const data = await getSharedLiveLocationPayload(req.params.shareToken);
        res.status(200).json({
            success: true,
            data,
        });
    } catch (error) {
        logger.error('Error fetching shared driver live location:', error);
        res.status(400).json({ message: error.message });
    }
};

module.exports = {
    addDriver,
    addDriverDocuments,
    loginDriver,
    getAllDrivers,
    getDriverById,
    deleteDriver,
    updateDriver,
    updateDriverDocuments,
    updateDriverIsReadyForRides,
    getAllRidesOfDriver,
    getUpcomingBookings,
    updateDriverLocation,
    upsertDriverGoToHome,
    activateDriverGoTo,
    deactivateDriverGoTo,
    getDriverGoToStatus,
    updateDriverOnlineStatus,
    logoutDriver,
    updateDriverVehicle,
    approveDriverVehicle,
    rejectDriverVehicle,
    getDriverEarnings,
    getDriverStats,
    getNearbyDrivers,
    updateDriverBusyStatus,
    markCashCollected,
    uploadPriorityDocument,
    approvePriorityDriver,
    rejectPriorityDriver,
    getDriverDocuments,
    getDriverOnlineHours,
    updateDriverComplianceDocuments,
    resubmitDriverApproval,
    createDriverLocationShare,
    listDriverLocationShares,
    deleteDriverLocationShare,
    getSharedDriverLocation
};
