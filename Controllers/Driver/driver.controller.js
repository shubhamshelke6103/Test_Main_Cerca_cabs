const mongoose = require('mongoose');
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
const { deleteDriverDocuments } = require('../../utils/driverDocument.service.js');
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
    getMissingDriverApprovalDocuments,
    setDriverPendingApproval,
    DRIVER_APPROVAL_STATUS,
} = require('../../utils/driverApproval.service.js');
const {
    sanitizeRideListContactsForDriver,
} = require('../../utils/rideContactPrivacy.service.js');
const { cancelRide: cancelRideFromBooking } = require('../../utils/ride_booking_functions.js');
const { queueExternalAlertEmail } = require('../../utils/alerting.service.js');
const { getSocketIO, emitRideCancelledToClients } = require('../../utils/socket.js');
const { normalizeEmail, normalizeMobileDigits } = require('../../utils/contactValidation.js');
const AppError = require('../../utils/errors/AppError.js');
const asyncHandler = require('../../utils/errors/asyncHandler.js');

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

const MAX_DRIVER_OWNED_VEHICLES = parseInt(process.env.MAX_DRIVER_OWNED_VEHICLES || '5', 10);

const normalizeLicensePlateKey = (plate) => String(plate || '').replace(/\s+/g, '').toUpperCase();

const DOCUMENT_TYPE_LABELS = {
    AADHAAR_CARD: 'Aadhaar Card',
    PAN_CARD: 'PAN Card',
    DRIVING_LICENSE: 'Driving License',
    VEHICLE_RC: 'Vehicle RC',
    RC: 'Vehicle RC',
    INSURANCE: 'Insurance',
    PERMIT: 'Permit',
    PUC: 'PUC',
    GST_CERTIFICATE: 'GST Certificate',
    BUSINESS_LICENSE: 'Business License',
    PASSPORT: 'Passport',
    VOTER_ID: 'Voter ID',
};

const buildUploadedFileUrl = (req, file) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const normalizedPath = String(file.path || '').replace(/\\/g, '/');
    return `${baseUrl}/${normalizedPath}`;
};

const normalizeDocumentTypeKey = (value) => String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

const inferDocumentTypeFromName = (value) => {
    const normalized = String(value || '').toLowerCase();
    if (normalized.includes('aadhaar') || normalized.includes('aadhar')) return 'AADHAAR_CARD';
    if (normalized.includes('pan')) return 'PAN_CARD';
    if (normalized.includes('license') || normalized.includes('licence') || normalized.includes('dl')) return 'DRIVING_LICENSE';
    if (normalized.includes('gst')) return 'GST_CERTIFICATE';
    if (normalized.includes('business')) return 'BUSINESS_LICENSE';
    if (normalized.includes('passport')) return 'PASSPORT';
    if (normalized.includes('voter')) return 'VOTER_ID';
    return null;
};

const getDocumentDisplayName = (documentType, url, fallbackIndex = 0) => {
    const normalizedType = normalizeDocumentTypeKey(documentType);
    if (normalizedType && DOCUMENT_TYPE_LABELS[normalizedType]) {
        return DOCUMENT_TYPE_LABELS[normalizedType];
    }

    const inferredType = inferDocumentTypeFromName(documentType || url);
    if (inferredType && DOCUMENT_TYPE_LABELS[inferredType]) {
        return DOCUMENT_TYPE_LABELS[inferredType];
    }

    return `Document ${fallbackIndex + 1}`;
};

const buildUploadedDocumentEntry = (req, file, explicitType = null) => {
    const inferredType = explicitType || inferDocumentTypeFromName(file?.originalname) || 'DOCUMENT';
    return {
        documentType: normalizeDocumentTypeKey(inferredType),
        documentUrl: buildUploadedFileUrl(req, file),
    };
};

const normalizeStoredDocumentEntry = (req, document, index = 0) => {
    const rawDocument = typeof document === 'string'
        ? { documentType: inferDocumentTypeFromName(document), documentUrl: document }
        : document || {};
    const rawUrl = String(rawDocument.documentUrl || rawDocument.url || '').trim();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let documentUrl = rawUrl;

    if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
        const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
        documentUrl = `${baseUrl}${path}`;
    }

    const documentType = normalizeDocumentTypeKey(rawDocument.documentType || inferDocumentTypeFromName(rawUrl));

    return {
        documentType: documentType || null,
        documentName: getDocumentDisplayName(documentType, rawUrl, index),
        documentUrl,
    };
};

/** Multipart field name → stored documentType (driver identity uploads). */
const DRIVER_IDENTITY_FIELD_TYPES = {
    aadhaarCard: 'AADHAAR_CARD',
    panCard: 'PAN_CARD',
    drivingLicense: 'DRIVING_LICENSE',
};

/** Legacy `documents[]` order matches onboarding: Aadhaar, Driving license, PAN. */
const LEGACY_DOCUMENTS_ORDER_TYPES = ['AADHAAR_CARD', 'DRIVING_LICENSE', 'PAN_CARD'];

const IDENTITY_DOC_TYPES_FOR_MERGE = new Set(['AADHAAR_CARD', 'PAN_CARD', 'DRIVING_LICENSE']);

/**
 * @returns {{ error: string|null, entries: object[], mode: 'named'|'legacy'|null }}
 */
const collectDriverIdentityUploads = (req) => {
    const f = req.files;

    if (f == null) {
        return { error: 'No files uploaded', entries: [], mode: null };
    }

    const entries = [];

    if (Array.isArray(f)) {
        if (f.length === 0) {
            return { error: 'No files uploaded', entries: [], mode: null };
        }
        if (f.length > 3) {
            return {
                error: 'At most 3 files allowed in legacy documents upload; use aadhaarCard, panCard, and drivingLicense fields instead.',
                entries: [],
                mode: 'legacy',
            };
        }
        f.forEach((file, index) => {
            entries.push(
                buildUploadedDocumentEntry(req, file, LEGACY_DOCUMENTS_ORDER_TYPES[index])
            );
        });
        return { error: null, entries, mode: 'legacy' };
    }

    if (typeof f === 'object') {
        let hasNamed = false;
        Object.entries(DRIVER_IDENTITY_FIELD_TYPES).forEach(([field, type]) => {
            const arr = f[field];
            if (arr && arr[0]) {
                hasNamed = true;
                entries.push(buildUploadedDocumentEntry(req, arr[0], type));
            }
        });
        if (hasNamed) {
            return { error: null, entries, mode: 'named' };
        }

        const legacyArr = f.documents;
        if (legacyArr && legacyArr.length > 0) {
            if (legacyArr.length > 3) {
                return {
                    error: 'At most 3 files allowed in legacy documents upload; use aadhaarCard, panCard, and drivingLicense fields instead.',
                    entries: [],
                    mode: 'legacy',
                };
            }
            legacyArr.forEach((file, index) => {
                entries.push(
                    buildUploadedDocumentEntry(req, file, LEGACY_DOCUMENTS_ORDER_TYPES[index])
                );
            });
            return { error: null, entries, mode: 'legacy' };
        }
    }

    return { error: 'No files uploaded', entries: [], mode: null };
};

/** Remove + delete files for matching identity types, then append new rows. */
const mergeIdentityDriverDocuments = (driver, newEntries) => {
    const existing = Array.isArray(driver.documents) ? [...driver.documents] : [];
    let merged = [...existing];

    newEntries.forEach((newEntry) => {
        const nt = normalizeDocumentTypeKey(newEntry.documentType);
        if (!nt || !IDENTITY_DOC_TYPES_FOR_MERGE.has(nt)) {
            return;
        }
        const toRemove = merged.filter(
            (d) => normalizeDocumentTypeKey(d.documentType) === nt
        );
        deleteDriverDocuments(toRemove);
        merged = merged.filter((d) => normalizeDocumentTypeKey(d.documentType) !== nt);
        merged.push(newEntry);
    });

    driver.documents = merged;
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

const resolveVehicleStatus = (driver) => (
    driver.pendingVehicleInfo?.approvalStatus ||
    (driver.vehicleInfo || driver.assignedFleetVehicleId ? 'APPROVED' : 'NOT_ADDED')
);

const toPlainVehicleRecord = (vehicleRecord) => (
    vehicleRecord?.toObject ? vehicleRecord.toObject() : vehicleRecord
);

const getOwnedVehicleRecords = (driver) => (
    Array.isArray(driver?.vehicles) ? driver.vehicles : []
);

/**
 * Drops embedded vehicle document entries that fail schema validation (e.g. missing
 * documentUrl) so a new submission does not fail on legacy bad rows.
 */
const sanitizeOwnedVehicleDocuments = (driver) => {
    getOwnedVehicleRecords(driver).forEach((vehicle) => {
        if (!vehicle || typeof vehicle !== 'object') return;
        if (!Array.isArray(vehicle.documents)) {
            vehicle.documents = [];
            return;
        }
        vehicle.documents = vehicle.documents.filter(
            (doc) =>
                doc &&
                typeof doc.documentUrl === 'string' &&
                doc.documentUrl.trim() !== '' &&
                doc.documentType,
        );
    });
    const p = driver.pendingVehicleInfo;
    if (p && typeof p === 'object' && Array.isArray(p.documents)) {
        p.documents = p.documents.filter(
            (doc) =>
                doc &&
                typeof doc.documentUrl === 'string' &&
                doc.documentUrl.trim() !== '' &&
                doc.documentType,
        );
    }
};

const getLatestOwnedVehicleRecord = (driver, predicate) => {
    const vehicles = getOwnedVehicleRecords(driver);
    for (let index = vehicles.length - 1; index >= 0; index -= 1) {
        if (predicate(vehicles[index])) {
            return vehicles[index];
        }
    }
    return null;
};

const getPendingOwnedVehicleRecord = (driver) => {
    const sourceVehicleId = driver?.pendingVehicleInfo?.sourceVehicleId
        ? String(driver.pendingVehicleInfo.sourceVehicleId)
        : null;

    if (sourceVehicleId) {
        const matchingVehicle = getOwnedVehicleRecords(driver).find(
            vehicle => String(vehicle._id) === sourceVehicleId
        );
        if (matchingVehicle) {
            return matchingVehicle;
        }
    }

    return getLatestOwnedVehicleRecord(
        driver,
        vehicle => vehicle.approvalStatus === 'UNDER_APPROVAL' || vehicle.approvalStatus === 'REJECTED'
    );
};

const getActiveOwnedVehicleRecord = (driver) => {
    const activeVehicle = getLatestOwnedVehicleRecord(
        driver,
        vehicle => vehicle.approvalStatus === 'APPROVED' && vehicle.isActive
    );

    if (activeVehicle) {
        return activeVehicle;
    }

    return getLatestOwnedVehicleRecord(
        driver,
        vehicle => vehicle.approvalStatus === 'APPROVED'
    );
};

const buildLegacyVehicleInfoFromRecord = (vehicleRecord) => {
    if (!vehicleRecord) return null;

    return {
        make: vehicleRecord.make,
        model: vehicleRecord.model,
        year: vehicleRecord.year,
        color: vehicleRecord.color,
        licensePlate: vehicleRecord.licensePlate,
        vehicleType: vehicleRecord.vehicleType,
    };
};

const buildLegacyPendingVehicleFromRecord = (vehicleRecord) => {
    if (!vehicleRecord) return null;

    return {
        ...toPlainVehicleRecord(vehicleRecord),
        sourceVehicleId: vehicleRecord._id,
    };
};

const syncLegacyVehicleState = (driver) => {
    const activeVehicle = getActiveOwnedVehicleRecord(driver);
    const pendingVehicle = getPendingOwnedVehicleRecord(driver);

    if (!driver.assignedFleetVehicleId) {
        driver.vehicleInfo = buildLegacyVehicleInfoFromRecord(activeVehicle);
    }
    driver.pendingVehicleInfo = buildLegacyPendingVehicleFromRecord(pendingVehicle);

    return driver;
};

const serializeOwnedVehicles = (driver) => (
    getOwnedVehicleRecords(driver).map(vehicle => toPlainVehicleRecord(vehicle))
);

const serializeVehicleState = (driver) => {
    const activeRec = getActiveOwnedVehicleRecord(driver);
    return {
        approvedVehicle: driver.vehicleInfo || driver.assignedFleetVehicleId || null,
        pendingVehicle: driver.pendingVehicleInfo || null,
        vehicleStatus: resolveVehicleStatus(driver),
        vehicles: serializeOwnedVehicles(driver),
        activeVehicleId: activeRec && activeRec._id ? String(activeRec._id) : null,
    };
};

const hasDriverVehicleState = (driver) => (
    Boolean(
        driver?.vehicleInfo ||
        driver?.pendingVehicleInfo ||
        driver?.assignedFleetVehicleId ||
        (Array.isArray(driver?.vehicles) && driver.vehicles.length > 0)
    )
);

const clearDriverVehicleState = (driver) => {
    const vehicles = getOwnedVehicleRecords(driver);
    const pendingVehicle = getPendingOwnedVehicleRecord(driver);
    const activeVehicle = getActiveOwnedVehicleRecord(driver);
    const targetVehicle = pendingVehicle || activeVehicle;
    const removed = {
        approvedVehicle: Boolean(activeVehicle || driver.vehicleInfo),
        pendingVehicle: Boolean(pendingVehicle || driver.pendingVehicleInfo),
        assignedFleetVehicle: Boolean(driver.assignedFleetVehicleId),
    };

    if (targetVehicle) {
        driver.vehicles = vehicles.filter(
            vehicle => String(vehicle._id) !== String(targetVehicle._id)
        );
    }

    const fallbackApprovedVehicle = getLatestOwnedVehicleRecord(
        driver,
        vehicle => vehicle.approvalStatus === 'APPROVED'
    );
    getOwnedVehicleRecords(driver).forEach((vehicle) => {
        vehicle.isActive =
            Boolean(fallbackApprovedVehicle) &&
            String(vehicle._id) === String(fallbackApprovedVehicle._id);
    });

    syncLegacyVehicleState(driver);
    driver.assignedFleetVehicleId = null;

    return removed;
};

const serializeDriverApprovalState = (driver) => ({
    approvalStatus: getDriverApprovalSummary(driver).status,
    approvalWorkflow: getDriverApprovalSummary(driver),
    missingDocuments: getMissingDriverApprovalDocuments(driver),
});

const queueDriverVehicleApprovedEmail = (driver, approvedBy = 'ADMIN') => {
    if (!driver?.email) return;

    setImmediate(async () => {
        try {
            await queueExternalAlertEmail({
                channel: 'email',
                to: driver.email,
                subject: 'Vehicle approved',
                message: `Hi ${driver.name || 'Driver'}, your vehicle has been approved by ${approvedBy === 'VENDOR' ? 'your vendor' : 'Cerca admin'}. You can now use the approved vehicle for rides.`,
                metadata: {
                    purpose: 'driver_vehicle_approved',
                    driverId: driver._id,
                    approvedBy,
                },
            });
        } catch (emailErr) {
            logger.error(
                `Driver vehicle approval email queue error for ${driver.email}: ${emailErr.message}`
            );
        }
    });
};

const approvePendingVehicleForDriver = async (driver, approvedBy = 'ADMIN', vehicleSubdocId = null) => {
    let pendingVehicleRecord;
    if (vehicleSubdocId) {
        pendingVehicleRecord = getOwnedVehicleRecords(driver).find(
            (v) => String(v._id) === String(vehicleSubdocId)
        );
        if (!pendingVehicleRecord || pendingVehicleRecord.approvalStatus !== 'UNDER_APPROVAL') {
            throw new Error('No pending vehicle found for this id');
        }
        if (approvedBy === 'ADMIN' && pendingVehicleRecord.approvalRoutedTo !== 'ADMIN') {
            throw new Error('This vehicle approval is not routed to admin');
        }
    } else {
        pendingVehicleRecord = getPendingOwnedVehicleRecord(driver);
        if (!pendingVehicleRecord || pendingVehicleRecord.approvalStatus !== 'UNDER_APPROVAL') {
            throw new Error('No pending vehicle found');
        }
    }

    const hadAnotherActiveApproved = getOwnedVehicleRecords(driver).some(
        (v) =>
            v !== pendingVehicleRecord &&
            v.approvalStatus === 'APPROVED' &&
            v.isActive
    );

    pendingVehicleRecord.approvalStatus = 'APPROVED';
    pendingVehicleRecord.approvedAt = new Date();
    pendingVehicleRecord.rejectedAt = null;
    pendingVehicleRecord.rejectionReason = null;
    pendingVehicleRecord.allowDocumentResubmit = false;
    pendingVehicleRecord.approvedBy = approvedBy;

    if (!hadAnotherActiveApproved) {
        getOwnedVehicleRecords(driver).forEach((vehicle) => {
            if (vehicle !== pendingVehicleRecord && vehicle.approvalStatus === 'APPROVED') {
                vehicle.isActive = false;
            }
        });
        pendingVehicleRecord.isActive = true;
    } else {
        pendingVehicleRecord.isActive = false;
    }

    driver.pendingVehicleInfo = null;
    syncLegacyVehicleState(driver);
    await driver.save();

    return driver;
};

const rejectPendingVehicleForDriver = async (
    driver,
    reason,
    allowDocumentResubmit = false,
    vehicleSubdocId = null
) => {
    let pendingVehicleRecord;
    if (vehicleSubdocId) {
        pendingVehicleRecord = getOwnedVehicleRecords(driver).find(
            (v) => String(v._id) === String(vehicleSubdocId)
        );
        if (!pendingVehicleRecord || pendingVehicleRecord.approvalStatus !== 'UNDER_APPROVAL') {
            throw new Error('No pending vehicle found for this id');
        }
        if (pendingVehicleRecord.approvalRoutedTo !== 'ADMIN') {
            throw new Error('This vehicle approval is not routed to admin');
        }
    } else {
        pendingVehicleRecord = getPendingOwnedVehicleRecord(driver);
        if (!pendingVehicleRecord) {
            throw new Error('No pending vehicle found');
        }
    }

    pendingVehicleRecord.approvalStatus = 'REJECTED';
    pendingVehicleRecord.rejectedAt = new Date();
    pendingVehicleRecord.approvedAt = null;
    pendingVehicleRecord.rejectionReason = reason;
    pendingVehicleRecord.allowDocumentResubmit = Boolean(allowDocumentResubmit);
    pendingVehicleRecord.isActive = false;

    syncLegacyVehicleState(driver);
    await driver.save();
    return driver;
};

/**
 * @desc    Add a new driver
 * @route   POST /drivers
 */
const addDriver = asyncHandler(async (req, res) => {
        const { name, password, location } = req.body;
        const phoneResult = normalizeMobileDigits(req.body.phone);
        if (phoneResult.error || !phoneResult.value) {
            throw new AppError(phoneResult.error || 'Phone number is required', 400, {
                code: 'INVALID_PHONE_NUMBER',
            });
        }
        const phone = phoneResult.value;
        const emailResult = normalizeEmail(req.body.email);
        if (emailResult.error) {
            throw new AppError(emailResult.error, 400, {
                code: 'INVALID_EMAIL',
            });
        }
        const email = emailResult.value;

        console.log('Received driver data:');
        console.log(req.body);
        
        let driver = await Driver.findOne({ phone });
        if (driver) {
            throw new AppError('Driver with this phone number already exists', 400, {
                code: 'DRIVER_ALREADY_EXISTS',
            });
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
            vendorDriverCategory: 'SELF',
        });

        await driverObj.save();

        logger.info(`Driver added successfully: ${driverObj.email}`);
        res.status(201).json({ id: driverObj, message: 'Driver added successfully' });
});

/**
 * @desc    Add documents to a driver's documents array
 * @route   POST /drivers/:id/documents
 */
const addDriverDocuments = asyncHandler(async (req, res) => {
        const driverId = req.params.id;

        const { error, entries: documentEntries } = collectDriverIdentityUploads(req);
        if (error) {
            throw new AppError(error, 400, {
                code: 'INVALID_DRIVER_DOCUMENTS',
            });
        }

        const driver = await Driver.findById(driverId);

        if (!driver) {
            throw new AppError('Driver not found', 404, {
                code: 'DRIVER_NOT_FOUND',
            });
        }

        const approvalSummary = getDriverApprovalSummary(driver);
        const shouldReplaceExistingDocuments = approvalSummary.status === DRIVER_APPROVAL_STATUS.REJECTED;

        if (shouldReplaceExistingDocuments) {
            deleteDriverDocuments(driver.documents || []);
            driver.documents = documentEntries;
        } else {
            mergeIdentityDriverDocuments(driver, documentEntries);
        }

        driver.rejectionReason = null;
        await driver.save();

        logger.info(`Documents added to driver: ${driver.email}`);
        res.status(200).json({
            message: 'Documents added successfully',
            documents: (driver.documents || []).map((document, index) =>
                normalizeStoredDocumentEntry(req, document, index)
            )
        });
});

/**
 * @desc    Login driver by email and password
 * @route   POST /drivers/login
 */
const loginDriver = asyncHandler(async (req, res) => {
    const { password } = req.body;
    const emailResult = normalizeEmail(req.body.email);
    if (emailResult.error || !emailResult.value) {
        throw new AppError(emailResult.error || 'Email is required', 400, {
            code: 'INVALID_EMAIL',
        });
    }
    const email = emailResult.value;

    if (password == null || typeof password !== 'string') {
        throw new AppError('Password is required', 400, {
            code: 'PASSWORD_REQUIRED',
        });
    }

    const driver = await Driver.findOne({ email });

    if (!driver) {
        throw new AppError('Driver not found', 404, {
            code: 'DRIVER_NOT_FOUND',
        });
    }

    if (typeof driver.password !== 'string' || !driver.password) {
        logger.warn(`Driver login rejected: missing password hash on record for ${driver.email}`);
        throw new AppError('Invalid credentials', 401, {
            code: 'INVALID_CREDENTIALS',
        });
    }

        // Check password (guarded above so bcrypt does not throw on bad hash field)
        const isMatch = await bcrypt.compare(password, driver.password);

    if (!isMatch) {
        throw new AppError('Invalid credentials', 401, {
            code: 'INVALID_CREDENTIALS',
        });
    }

        // Generate JWT token
        const token = jwt.sign(
            { id: driver._id, email: driver.email },
            "@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%",
            { expiresIn: '7d' }
        );

        // Do not start an online session on login — fleet/vehicle eligibility is enforced when the driver
        // actually goes online (PATCH /drivers/:id/online-status). Starting a session here caused 500s for
        // vendor drivers who had not yet been assigned an approved fleet vehicle.
        await Driver.findByIdAndUpdate(driver._id, { $set: { lastSeen: new Date() } });

        const approvalSummary = getDriverApprovalSummary(driver);
        const missingDocuments = getMissingDriverApprovalDocuments(driver);

    logger.info(`Driver logged in: ${driver.email}`);
    res.status(200).json({
        message: 'Login successful',
        token,
        id: driver._id,
        approvalStatus: approvalSummary.status,
        missingDocuments,
    });
});

/**
 * @desc    Get all drivers
 * @route   GET /drivers
 */
const getAllDrivers = asyncHandler(async (req, res) => {
    const drivers = await Driver.find();
    res.status(200).json(drivers);
});

/**
 * @desc    Get a driver by ID
 * @route   GET /drivers/:id
 */
const getDriverById = asyncHandler(async (req, res) => {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            throw new AppError('Driver not found', 404, {
                code: 'DRIVER_NOT_FOUND',
            });
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
        driverObj.vehicleStatus = resolveVehicleStatus(driver);
        const activeRec = getActiveOwnedVehicleRecord(driver);
        driverObj.activeVehicleId = activeRec && activeRec._id ? String(activeRec._id) : null;
        Object.assign(driverObj, serializeDriverApprovalState(driver));

        res.status(200).json(driverObj);
});

/**
 * @desc    Delete a driver by ID
 * @route   DELETE /drivers/:id
 */
const deleteDriver = asyncHandler(async (req, res) => {
        const driver = await Driver.findByIdAndDelete(req.params.id);

        if (!driver) {
            throw new AppError('Driver not found', 404, {
                code: 'DRIVER_NOT_FOUND',
            });
        }

        logger.info(`Driver deleted successfully: ${driver.email}`);
        res.status(200).json({ message: 'Driver deleted successfully' });
});

/**
 * @desc    Update a driver by ID
 * @route   PUT /drivers/:id
 */
const updateDriver = asyncHandler(async (req, res) => {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            throw new AppError('Driver not found', 404, {
                code: 'DRIVER_NOT_FOUND',
            });
        }

        if (Array.isArray(req.body?.trustedContacts) && req.body.trustedContacts.length > 5) {
            throw new AppError('Driver can add up to 5 emergency contacts only', 400, {
                code: 'TRUSTED_CONTACT_LIMIT_EXCEEDED',
            });
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
});

/**
 * @desc    Update a driver's documents
 * @route   PUT /drivers/:id/documents
 */
const updateDriverDocuments = asyncHandler(async (req, res) => {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            throw new AppError('Driver not found', 404, {
                code: 'DRIVER_NOT_FOUND',
            });
        }

        const { error, entries: documentEntries, mode } = collectDriverIdentityUploads(req);
        if (error) {
            throw new AppError(error, 400, {
                code: 'INVALID_DRIVER_DOCUMENTS',
            });
        }

        if (mode === 'legacy') {
            deleteDriverDocuments(driver.documents || []);
            driver.documents = documentEntries;
        } else {
            mergeIdentityDriverDocuments(driver, documentEntries);
        }

        driver.rejectionReason = null;
        await driver.save();

        logger.info(`Driver documents updated successfully: ${driver.email}`);
        res.status(200).json({
            message: 'Driver documents updated successfully',
            documents: (driver.documents || []).map((document, index) =>
                normalizeStoredDocumentEntry(req, document, index)
            )
        });
});

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
        
        res.status(200).json({ rides: sanitizeRideListContactsForDriver(sortedRides) });
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
            bookings: sanitizeRideListContactsForDriver(upcomingBookings),
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

        const goToPayload = deactivateGoToState(
            driver.goTo?.toObject?.() || driver.goTo || {}
        );
        // Atomic $set avoids full-document save() validation on legacy `documents` entries.
        const updated = await Driver.findByIdAndUpdate(
            req.params.id,
            { $set: { goTo: goToPayload } },
            { new: true, runValidators: true }
        );
        if (!updated) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        res.status(200).json({
            message: 'GO TO deactivated successfully',
            goTo: sanitizeGoToResponse(updated.goTo),
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
        const driverId = req.params.id;

        // Validate request body early
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

        // Fetch only the fields needed for validation (not entire driver document)
        const driver = await Driver.findById(driverId).select('vehicles vendorId email pendingVehicleInfo');

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const owned = getOwnedVehicleRecords(driver);

        // Check for pending approval
        const existingPending = getLatestOwnedVehicleRecord(
            driver,
            vehicle => vehicle.approvalStatus === 'UNDER_APPROVAL'
        );
        if (existingPending) {
            return res.status(400).json({
                message: 'A vehicle submission is already pending approval',
            });
        }

        // Check max vehicles limit
        if (owned.length >= MAX_DRIVER_OWNED_VEHICLES) {
            return res.status(400).json({
                message: `You can register at most ${MAX_DRIVER_OWNED_VEHICLES} vehicles`,
                maxVehicles: MAX_DRIVER_OWNED_VEHICLES,
            });
        }

        // Check for duplicate license plate
        const plateKey = normalizeLicensePlateKey(licensePlate);
        const duplicatePlate = owned.some(
            (v) =>
                normalizeLicensePlateKey(v.licensePlate) === plateKey &&
                (v.approvalStatus === 'APPROVED' || v.approvalStatus === 'UNDER_APPROVAL')
        );
        if (duplicatePlate) {
            return res.status(400).json({
                message: 'A vehicle with this license plate is already registered or awaiting approval',
            });
        }

        // Create the new vehicle object
        const newVehicle = {
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
            allowDocumentResubmit: false,
            vendorPreApprovedAt: null,
            approvedBy: null,
            isActive: false,
        };

        // Use atomic MongoDB update instead of loading entire document
        const updatedDriver = await Driver.findByIdAndUpdate(
            driverId,
            {
                $push: { vehicles: newVehicle },
                $set: {
                    pendingVehicleInfo: {
                        ...newVehicle,
                        sourceVehicleId: new mongoose.Types.ObjectId(), // Generate new ObjectId
                    },
                    updatedAt: new Date(),
                },
            },
            { new: true, select: 'vehicles pendingVehicleInfo vendorId' }
        );

        if (!updatedDriver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        logger.info(`Driver vehicle info updated: ${driver.email}`);
        res.status(200).json({ 
            message: `Vehicle submitted for ${driver.vendorId ? 'vendor' : 'admin'} approval successfully`,
            routedTo: driver.vendorId ? 'VENDOR' : 'ADMIN',
            vehicles: updatedDriver.vehicles,
            pendingVehicleInfo: updatedDriver.pendingVehicleInfo,
        });
    } catch (error) {
        logger.error('Error updating driver vehicle:', error);
        res.status(500).json({ message: 'Error updating driver vehicle information', error });
    }
};

/**
 * @desc    Reject an accidentally accepted ride before trip start
 * @route   PATCH /drivers/:driverId/rides/:rideId/reject-accepted
 */
const rejectAcceptedRide = async (req, res) => {
    try {
        const { driverId, rideId } = req.params;
        const { reason } = req.body || {};

        const ride = await Ride.findById(rideId)
            .select('status driver rider userSocketId driverSocketId')
            .populate('driver rider');

        if (!ride) {
            return res.status(404).json({ message: 'Ride not found' });
        }

        if (!ride.driver || String(ride.driver._id || ride.driver) !== String(driverId)) {
            return res.status(403).json({ message: 'You can only reject your own accepted ride' });
        }

        if (ride.status !== 'accepted') {
            return res.status(400).json({
                message: 'This option is only available for rides that are accepted and not yet started',
            });
        }

        const cancellationReason =
            typeof reason === 'string' && reason.trim()
                ? reason.trim()
                : 'Driver accidentally accepted the ride';

        const cancelledRide = await cancelRideFromBooking(
            rideId,
            'driver',
            cancellationReason
        );

        try {
            const io = getSocketIO();
            await emitRideCancelledToClients(
                io,
                cancelledRide,
                'driver',
                cancellationReason
            );
        } catch (socketErr) {
            logger.warn('Driver reject accepted ride: socket emit failed', socketErr);
        }

        return res.status(200).json({
            message: 'Accepted ride rejected successfully',
            ride: cancelledRide,
        });
    } catch (error) {
        logger.error('Error rejecting accepted ride:', error);
        return res.status(500).json({
            message: 'Error rejecting accepted ride',
            error: error.message,
        });
    }
};

const deleteDriverVehicle = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (driver.vendorId) {
            return res.status(403).json({
                message: 'Only the vendor can remove the vehicle for a vendor-registered driver',
            });
        }

        if (!hasDriverVehicleState(driver)) {
            return res.status(400).json({ message: 'No vehicle found for this driver' });
        }

        const removed = clearDriverVehicleState(driver);
        await driver.save();

        logger.info(`Driver removed own vehicle: ${driver.email}`);
        return res.status(200).json({
            message: 'Driver vehicle removed successfully',
            removed,
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error deleting driver vehicle:', error);
        return res.status(500).json({ message: 'Error deleting driver vehicle', error: error.message });
    }
};

/**
 * @desc    Set which approved owned vehicle is active for rides (self drivers only)
 * @route   PATCH /drivers/:id/vehicles/active
 */
const setDriverActiveOwnedVehicle = async (req, res) => {
    try {
        const { id } = req.params;
        const vehicleId = req.body?.vehicleId ?? req.body?.vehicle_id;
        if (!vehicleId || typeof vehicleId !== 'string') {
            return res.status(400).json({ message: 'vehicleId is required' });
        }

        let vehicleObjectId;
        try {
            vehicleObjectId = new mongoose.Types.ObjectId(vehicleId);
        } catch {
            return res.status(400).json({ message: 'Invalid vehicleId' });
        }

        const driver = await Driver.findById(id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (driver.vendorId) {
            return res.status(403).json({
                message: 'Vendor drivers use fleet assignment; active owned vehicle is not applicable',
            });
        }
        if (driver.assignedFleetVehicleId) {
            return res.status(403).json({
                message: 'Clear fleet vehicle assignment before managing owned vehicles',
            });
        }

        const target = getOwnedVehicleRecords(driver).find(
            (v) => String(v._id) === String(vehicleId)
        );
        if (!target) {
            return res.status(404).json({ message: 'Vehicle not found on this driver' });
        }
        if (target.approvalStatus !== 'APPROVED') {
            return res.status(400).json({ message: 'Only an approved vehicle can be set active' });
        }

        const applyFallbackSave = async () => {
            const fresh = await Driver.findById(id);
            if (!fresh) {
                return res.status(404).json({ message: 'Driver not found' });
            }
            getOwnedVehicleRecords(fresh).forEach((v) => {
                v.isActive = String(v._id) === String(vehicleId);
            });
            syncLegacyVehicleState(fresh);
            await fresh.save();
            return res.status(200).json({
                message: 'Active vehicle updated',
                ...serializeVehicleState(fresh),
            });
        };

        try {
            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                await Driver.updateOne(
                    { _id: driver._id },
                    { $set: { 'vehicles.$[].isActive': false } },
                    { session }
                );
                await Driver.updateOne(
                    { _id: driver._id, 'vehicles._id': vehicleObjectId },
                    { $set: { 'vehicles.$.isActive': true } },
                    { session }
                );
                await session.commitTransaction();
            } catch (txErr) {
                await session.abortTransaction();
                throw txErr;
            } finally {
                session.endSession();
            }
        } catch (txErr) {
            logger.warn('setDriverActiveOwnedVehicle: transaction failed, using save fallback', {
                error: txErr?.message,
            });
            return await applyFallbackSave();
        }

        const updated = await Driver.findById(id);
        if (!updated) {
            return res.status(404).json({ message: 'Driver not found' });
        }
        syncLegacyVehicleState(updated);
        await updated.save();

        return res.status(200).json({
            message: 'Active vehicle updated',
            ...serializeVehicleState(updated),
        });
    } catch (error) {
        logger.error('Error setting active vehicle:', error);
        return res.status(500).json({ message: 'Error setting active vehicle', error: error.message });
    }
};

/**
 * @desc    Remove one owned vehicle from garage by subdocument id (self drivers)
 * @route   DELETE /drivers/:id/vehicles/:vehicleId
 */
const deleteDriverGarageVehicle = async (req, res) => {
    try {
        const { id, vehicleId } = req.params;
        const driver = await Driver.findById(id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (driver.vendorId) {
            return res.status(403).json({
                message: 'Only the vendor can manage vehicles for vendor-registered drivers',
            });
        }

        const sub = driver.vehicles.id(vehicleId);
        if (!sub) {
            return res.status(404).json({ message: 'Vehicle not found on this driver' });
        }

        const wasActiveApproved = sub.approvalStatus === 'APPROVED' && sub.isActive;
        driver.vehicles.pull({ _id: sub._id });

        if (wasActiveApproved) {
            const nextActive = getLatestOwnedVehicleRecord(
                driver,
                (v) => v.approvalStatus === 'APPROVED'
            );
            getOwnedVehicleRecords(driver).forEach((v) => {
                v.isActive = Boolean(
                    nextActive && String(v._id) === String(nextActive._id)
                );
            });
        }

        syncLegacyVehicleState(driver);
        await driver.save();

        logger.info(`Driver removed garage vehicle subdoc: ${driver.email} vehicleId=${vehicleId}`);
        return res.status(200).json({
            message: 'Vehicle removed from garage',
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error deleting garage vehicle:', error);
        return res.status(500).json({ message: 'Error deleting garage vehicle', error: error.message });
    }
};

const approveDriverVehicle = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const pendingForAdmin = getPendingOwnedVehicleRecord(driver);
        if (!pendingForAdmin || pendingForAdmin.approvalStatus !== 'UNDER_APPROVAL') {
            return res.status(400).json({ message: 'No pending vehicle approval found' });
        }

        if (pendingForAdmin.approvalRoutedTo !== 'ADMIN') {
            return res.status(403).json({ message: 'This vehicle approval is routed to vendor' });
        }

        await approvePendingVehicleForDriver(driver, 'ADMIN');
        queueDriverVehicleApprovedEmail(driver, 'ADMIN');

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

        const pendingForAdmin = getPendingOwnedVehicleRecord(driver);
        if (!pendingForAdmin || pendingForAdmin.approvalStatus !== 'UNDER_APPROVAL') {
            return res.status(400).json({ message: 'No pending vehicle approval found' });
        }

        if (pendingForAdmin.approvalRoutedTo !== 'ADMIN') {
            return res.status(403).json({ message: 'This vehicle approval is routed to vendor' });
        }

        if (typeof reason !== 'string' || !reason.trim()) {
            return res.status(400).json({ message: 'Rejection reason is required' });
        }

        const allowDocumentResubmit = Boolean(req.body?.allowDocumentResubmit);
        await rejectPendingVehicleForDriver(driver, reason.trim(), allowDocumentResubmit);

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
 * Approve a specific pending owned vehicle (admin). Supports multi-pending Phase B.
 * @route PATCH /admin/drivers/:id/vehicles/:vehicleId/approve
 */
const approveDriverVehicleBySubdoc = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        await approvePendingVehicleForDriver(driver, 'ADMIN', req.params.vehicleId);
        queueDriverVehicleApprovedEmail(driver, 'ADMIN');

        return res.status(200).json({
            message: 'Driver vehicle approved successfully',
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error approving driver vehicle by subdoc:', error);
        return res.status(500).json({ message: 'Error approving driver vehicle', error: error.message });
    }
};

/**
 * @route PATCH /admin/drivers/:id/vehicles/:vehicleId/reject
 */
const rejectDriverVehicleBySubdoc = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);
        const reason = req.body?.reason;

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (typeof reason !== 'string' || !reason.trim()) {
            return res.status(400).json({ message: 'Rejection reason is required' });
        }

        const allowDocumentResubmit = Boolean(req.body?.allowDocumentResubmit);
        await rejectPendingVehicleForDriver(
            driver,
            reason.trim(),
            allowDocumentResubmit,
            req.params.vehicleId
        );

        return res.status(200).json({
            message: 'Driver vehicle rejected successfully',
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error rejecting driver vehicle by subdoc:', error);
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
        res.status(200).json({
            documents: (driver.documents || []).map((document, index) =>
                normalizeStoredDocumentEntry(req, document, index)
            )
        });
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
        driverObj.vehicleStatus = resolveVehicleStatus(driver);
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
    rejectAcceptedRide,
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
    setDriverActiveOwnedVehicle,
    approveDriverVehicle,
    rejectDriverVehicle,
    approveDriverVehicleBySubdoc,
    rejectDriverVehicleBySubdoc,
    syncDriverLegacyVehicleFields: syncLegacyVehicleState,
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
