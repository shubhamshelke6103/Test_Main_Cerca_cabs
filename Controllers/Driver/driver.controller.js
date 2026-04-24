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
const { notifyAdminsRegistrationEvent } = require('../../utils/adminRegistrationNotify.js');
const { resolveAggregateVehicleStatus: resolveVehicleStatus } = require('../../utils/driverVehicleAggregateStatus.js');
const {
    buildInitialApprovalWorkflow,
    getDriverApprovalSummary,
    getMissingDriverApprovalDocuments,
    setDriverPendingApproval,
    DRIVER_APPROVAL_STATUS,
} = require('../../utils/driverApproval.service.js');
const {
    sanitizeRideListContactsForDriver,
    sanitizeRideContactsForDriver,
} = require('../../utils/rideContactPrivacy.service.js');
const {
    cancelRide: cancelRideFromBooking,
    getRideAccessDefaultsForVehicleType,
    createNotification,
} = require('../../utils/ride_booking_functions.js');
const { queueExternalAlertEmail } = require('../../utils/alerting.service.js');
const { getSocketIO, emitRideCancelledToClients } = require('../../utils/socket.js');
const { normalizeEmail, normalizeMobileDigits } = require('../../utils/contactValidation.js');
const { checkAndAssignProximityRides } = require('../../utils/proximityRide.service.js');
const AppError = require('../../utils/errors/AppError.js');
const asyncHandler = require('../../utils/errors/asyncHandler.js');
const {
    buildDriverProfilePicUrl,
    unlinkDriverProfilePicFile,
    isAllowedProfilePicMime,
} = require('../../utils/driverProfilePic.service.js');

const DRIVER_JWT_SECRET =
    process.env.JWT_SECRET ||
    '@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%';

const signDriverAuthToken = (driver) =>
    jwt.sign({ id: driver._id, email: driver.email }, DRIVER_JWT_SECRET, { expiresIn: '7d' });

const buildDriverRegisterResponsePayload = (driverObj) => ({
    id: driverObj,
    message: 'Driver added successfully',
    token: signDriverAuthToken(driverObj),
});

const buildDriverRegisterResponsePayloadFromDoc = (driverDoc) =>
    buildDriverRegisterResponsePayload(driverDoc);

const parseRegisterLocation = (raw) => {
    if (raw == null) {
        throw new AppError('Location is required', 400, { code: 'LOCATION_REQUIRED' });
    }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return parsed;
        } catch {
            throw new AppError('Invalid location JSON', 400, { code: 'INVALID_LOCATION' });
        }
    }
    return raw;
};

/**
 * @desc    Register driver with multipart body (optional profilePic image)
 * @route   POST /drivers/register
 */
const registerDriver = asyncHandler(async (req, res) => {
        const { name, password, location: rawLocation } = req.body;
        const location = parseRegisterLocation(rawLocation);
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

        let driver = await Driver.findOne({ phone });
        if (driver) {
            throw new AppError('Driver with this phone number already exists', 400, {
                code: 'DRIVER_ALREADY_EXISTS',
            });
        }
        const hashedPassword = await bcrypt.hash(password, 10);

        const driverObj = new Driver({
            name,
            email,
            phone,
            password: hashedPassword,
            location,
            documents: [],
            approvalWorkflow: buildInitialApprovalWorkflow(null),
            vendorDriverCategory: 'SELF',
        });

        if (req.file) {
            if (!isAllowedProfilePicMime(req.file.mimetype)) {
                throw new AppError('Only JPEG, PNG, or WebP images are allowed', 400, {
                    code: 'INVALID_PROFILE_PIC_TYPE',
                });
            }
            driverObj.profilePic = buildDriverProfilePicUrl(req, req.file);
        }

        await driverObj.save();

        logger.info(`Driver added successfully: ${driverObj.email}`);
        setImmediate(() => {
            notifyAdminsRegistrationEvent({
                type: 'admin_new_driver',
                title: 'New driver registered',
                message: `${name} (${phone}) registered and is pending admin approval.`,
                entityKind: 'driver',
                entityId: driverObj._id,
                data: { driverName: name, phone },
            }).catch((e) => logger.error('admin registration notify (new driver):', e));
        });
        res.status(201).json(buildDriverRegisterResponsePayloadFromDoc(driverObj));
});

/**
 * @desc    Add a new driver (JSON body)
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
        setImmediate(() => {
            notifyAdminsRegistrationEvent({
                type: 'admin_new_driver',
                title: 'New driver registered',
                message: `${name} (${phone}) registered and is pending admin approval.`,
                entityKind: 'driver',
                entityId: driverObj._id,
                data: { driverName: name, phone },
            }).catch((e) => logger.error('admin registration notify (new driver):', e));
        });
        res.status(201).json(buildDriverRegisterResponsePayloadFromDoc(driverObj));
});

const patchDriverProfilePhoto = asyncHandler(async (req, res) => {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            throw new AppError('Driver not found', 404, { code: 'DRIVER_NOT_FOUND' });
        }
        if (!req.file) {
            throw new AppError('profilePic file is required', 400, { code: 'PROFILE_PIC_REQUIRED' });
        }
        if (!isAllowedProfilePicMime(req.file.mimetype)) {
            throw new AppError('Only JPEG, PNG, or WebP images are allowed', 400, {
                code: 'INVALID_PROFILE_PIC_TYPE',
            });
        }
        const nextUrl = buildDriverProfilePicUrl(req, req.file);
        if (driver.profilePic) {
            unlinkDriverProfilePicFile(driver.profilePic);
        }
        driver.profilePic = nextUrl;
        await driver.save();
        logger.info(`Driver profile photo updated: ${driver.email}`);
        res.status(200).json({
            success: true,
            message: 'Profile photo updated',
            profilePic: driver.profilePic,
        });
});

const deleteDriverProfilePhoto = asyncHandler(async (req, res) => {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            throw new AppError('Driver not found', 404, { code: 'DRIVER_NOT_FOUND' });
        }
        if (driver.profilePic) {
            unlinkDriverProfilePicFile(driver.profilePic);
        }
        driver.profilePic = null;
        await driver.save();
        res.status(200).json({
            success: true,
            message: 'Profile photo removed',
            profilePic: null,
        });
});

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

const syncRideAccessState = (driver) => {
    const activeVehicle = getActiveOwnedVehicleRecord(driver);
    const vehicleType = activeVehicle?.vehicleType || driver?.vehicleInfo?.vehicleType || null;
    const defaults = getRideAccessDefaultsForVehicleType(vehicleType);

    driver.rideAccess = {
        allowZip: defaults.allowZip,
        allowGlide: defaults.allowGlide,
        updatedAt: new Date(),
    };

    return driver;
};

const serializeOwnedVehicles = (driver) => (
    getOwnedVehicleRecords(driver).map(vehicle => toPlainVehicleRecord(vehicle))
);

/** Max vehicles in active garage (matches driver app). */
const MAX_GARAGE_VEHICLES = 5;

const serializeArchivedVehicles = (driver) => (
    Array.isArray(driver?.archivedVehicles)
        ? driver.archivedVehicles.map((v) => toPlainVehicleRecord(v))
        : []
);

/**
 * Snapshot a garage subdocument into archivedVehicles before removal.
 */
const pushArchivedSnapshot = (driver, sub) => {
    if (!sub) return;
    const plain = toPlainVehicleRecord(sub);
    if (!Array.isArray(driver.archivedVehicles)) {
        driver.archivedVehicles = [];
    }
    driver.archivedVehicles.push({
        sourceVehicleId: sub._id,
        archivedAt: new Date(),
        make: plain.make,
        model: plain.model,
        year: plain.year,
        color: plain.color,
        licensePlate: plain.licensePlate,
        vehicleType: plain.vehicleType || 'sedan',
        documents: Array.isArray(plain.documents) ? [...plain.documents] : [],
        approvalStatus: plain.approvalStatus || 'UNDER_APPROVAL',
        approvalRoutedTo: plain.approvalRoutedTo ?? null,
        submittedAt: plain.submittedAt || new Date(),
        approvedAt: plain.approvedAt,
        rejectedAt: plain.rejectedAt,
        rejectionReason: plain.rejectionReason,
        allowDocumentResubmit: plain.allowDocumentResubmit ?? false,
        vendorPreApprovedAt: plain.vendorPreApprovedAt,
        approvedBy: plain.approvedBy ?? null,
        isActive: false,
    });
};

const serializeVehicleState = (driver) => {
    const activeRec = getActiveOwnedVehicleRecord(driver);
    return {
        approvedVehicle: driver.vehicleInfo || driver.assignedFleetVehicleId || null,
        pendingVehicle: driver.pendingVehicleInfo || null,
        vehicleStatus: resolveVehicleStatus(driver),
        vehicles: serializeOwnedVehicles(driver),
        archivedVehicles: serializeArchivedVehicles(driver),
        activeVehicleId: activeRec && activeRec._id ? String(activeRec._id) : null,
        activeVehicleType: activeRec?.vehicleType || driver?.vehicleInfo?.vehicleType || null,
        rideAccess: driver.rideAccess || null,
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
        pushArchivedSnapshot(driver, targetVehicle);
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
    syncRideAccessState(driver);

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

const queueDriverVehicleRejectedEmail = (driver, reason, rejectedBy = 'ADMIN') => {
    if (!driver?.email) return;

    setImmediate(async () => {
        try {
            await queueExternalAlertEmail({
                channel: 'email',
                to: driver.email,
                subject: 'Vehicle rejected',
                message: `Hi ${driver.name || 'Driver'}, your vehicle has been rejected by ${rejectedBy === 'VENDOR' ? 'your vendor' : 'Cerca admin'}. Reason: ${reason || 'No reason provided'}. Please update your vehicle details and resubmit for approval.`,
                metadata: {
                    purpose: 'driver_vehicle_rejected',
                    driverId: driver._id,
                    rejectedBy,
                },
            });
        } catch (emailErr) {
            logger.error(
                `Driver vehicle rejection email queue error for ${driver.email}: ${emailErr.message}`
            );
        }
    });
};

const queueVendorDriverVehicleNotificationEmail = (driver, subject, message, purpose) => {
    if (!driver?.vendorId) return;

    setImmediate(async () => {
        try {
            const vendor = await Vendor.findById(driver.vendorId).select('businessName ownerName email');
            if (!vendor?.email) return;

            await queueExternalAlertEmail({
                channel: 'email',
                to: vendor.email,
                subject,
                message,
                metadata: {
                    purpose,
                    vendorId: vendor._id,
                    driverId: driver._id,
                },
            });
        } catch (emailErr) {
            logger.error(
                `Vendor driver vehicle notification email queue error for ${driver._id}: ${emailErr.message}`
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
    syncRideAccessState(driver);
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
        const wasRejected = approvalSummary.status === DRIVER_APPROVAL_STATUS.REJECTED;
        const shouldReplaceExistingDocuments = wasRejected;

        if (shouldReplaceExistingDocuments) {
            deleteDriverDocuments(driver.documents || []);
            driver.documents = documentEntries;
        } else {
            mergeIdentityDriverDocuments(driver, documentEntries);
        }

        if (wasRejected) {
            setDriverPendingApproval(driver);
        } else {
            driver.rejectionReason = null;
        }
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

        const token = signDriverAuthToken(driver);

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

        if (driver.profilePic) {
            unlinkDriverProfilePicFile(driver.profilePic);
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

        const approvalSummaryBefore = getDriverApprovalSummary(driver);
        const wasRejected = approvalSummaryBefore.status === DRIVER_APPROVAL_STATUS.REJECTED;

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

        if (wasRejected && mode === 'legacy') {
            setDriverPendingApproval(driver);
        } else if (!wasRejected) {
            driver.rejectionReason = null;
        }
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

        // Filter out scheduled rides that are not yet due
        const now = new Date();
        const activeRides = rides.filter(ride => {
            // Include all non-scheduled rides
            if (ride.scheduleType !== 'scheduled') {
                return true;
            }
            
            // For scheduled rides, only include if scheduled time has passed or is within 1 hour
            if (ride.scheduledAt) {
                const scheduledTime = new Date(ride.scheduledAt);
                const oneHourBefore = new Date(scheduledTime.getTime() - 60 * 60 * 1000);
                return now >= oneHourBefore;
            }
            
            // If no scheduledAt, include it (fallback)
            return true;
        });

        if(activeRides.length === 0) {
            return res.status(200).json({ message: 'No active rides found for this driver', rides: [] });
        }
        
        // Sort rides by status priority: active statuses first, then completed/cancelled
        // Status priority: in_progress > accepted/upcoming > requested > completed > cancelled
        const statusPriority = {
            'in_progress': 1,
            'accepted': 2,
            'upcoming': 2,
            'requested': 3,
            'completed': 4,
            'cancelled': 5
        };
        
        const sortedRides = activeRides.sort((a, b) => {
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

        // Check for proximity rides (async, don't wait for response)
        checkAndAssignProximityRides(req.params.id, [longitude, latitude]).catch(error => {
            logger.warn('Proximity ride check failed:', error.message);
        });

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

        // Check daily GoTo activation limits
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        // Reset counter if it's a new day
        if (!driver.goToLastActivationDate || driver.goToLastActivationDate < startOfToday || driver.goToLastActivationDate > endOfToday) {
            driver.goToDailyActivations = 0;
            driver.goToLastActivationDate = startOfToday;
        }

        // Check limits for non-priority drivers
        if (!driver.isPriorityDriver && driver.goToDailyActivations >= 2) {
            return res.status(400).json({
                message: 'Daily GoTo activation limit reached (2 per day for non-priority drivers)',
                error: 'DAILY_GOTO_LIMIT_EXCEEDED',
            });
        }

        const originCoordinates = normalizeLocationCoordinates(driver.location);
        const { homeAddress, homeLocation, corridorRadiusMeters } =
            resolveHomeLocationPayload(req.body, driver);

        driver.goTo = await buildGoToRouteSnapshot({
            origin: { coordinates: originCoordinates },
            destination: homeLocation,
            homeAddress,
            corridorRadiusMeters,
        });

        // Increment activation counter after successful route build
        driver.goToDailyActivations += 1;

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
 * @desc    Update driver vehicle information (new submission or in-place resubmit after REJECTED)
 * @route   PATCH /drivers/:id/vehicle
 */
const updateDriverVehicle = async (req, res) => {
    try {
        const { make, model, year, color, licensePlate, vehicleType } = req.body;
        const driverId = req.params.id;

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

        const driver = await Driver.findById(driverId);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const owned = getOwnedVehicleRecords(driver);
        const plateKey = normalizeLicensePlateKey(licensePlate);

        const existingUnderApproval = getLatestOwnedVehicleRecord(
            driver,
            (vehicle) => vehicle.approvalStatus === 'UNDER_APPROVAL'
        );
        if (existingUnderApproval) {
            return res.status(400).json({
                message: 'A vehicle submission is already pending approval',
            });
        }

        const target = getPendingOwnedVehicleRecord(driver);
        const isRejectedResubmit =
            target &&
            target.approvalStatus === 'REJECTED' &&
            target.allowDocumentResubmit !== false;

        if (isRejectedResubmit) {
            deleteDriverDocuments(target.documents || []);
            target.make = make;
            target.model = model;
            target.year = Number(year);
            target.color = color;
            target.licensePlate = licensePlate;
            target.vehicleType = vehicleType || 'cercaGlide';
            target.documents = documents;
            target.approvalStatus = 'UNDER_APPROVAL';
            target.approvalRoutedTo = driver.vendorId ? 'VENDOR' : 'ADMIN';
            target.submittedAt = new Date();
            target.approvedAt = null;
            target.rejectedAt = null;
            target.rejectionReason = null;
            target.allowDocumentResubmit = false;
            target.vendorPreApprovedAt = null;
            target.approvedBy = null;
            target.isActive = false;

            const duplicateOther = owned.some(
                (v) =>
                    String(v._id) !== String(target._id) &&
                    normalizeLicensePlateKey(v.licensePlate) === plateKey &&
                    (v.approvalStatus === 'APPROVED' || v.approvalStatus === 'UNDER_APPROVAL')
            );
            if (duplicateOther) {
                return res.status(400).json({
                    message: 'A vehicle with this license plate is already registered or awaiting approval',
                });
            }

            syncLegacyVehicleState(driver);
            driver.updatedAt = new Date();
            await driver.save();

            logger.info(`Driver vehicle resubmitted in place: ${driver.email} vehicleId=${target._id}`);
            if (!driver.vendorId) {
                setImmediate(() => {
                    notifyAdminsRegistrationEvent({
                        type: 'admin_vehicle_pending',
                        title: 'Vehicle pending approval',
                        message: `Driver ${driver.email || driverId}: vehicle ${licensePlate} resubmitted for admin approval.`,
                        entityKind: 'vehicle',
                        entityId: driverId,
                        path: '/folder/drivers',
                        data: {
                            licensePlate,
                            driverId: String(driverId),
                            source: 'driver_vehicle_resubmit',
                        },
                    }).catch((e) =>
                        logger.error('admin registration notify (driver vehicle resubmit):', e)
                    );
                });
            }

            const routedTo = driver.vendorId ? 'VENDOR' : 'ADMIN';
            return res.status(200).json({
                message: `Vehicle resubmitted for ${driver.vendorId ? 'vendor' : 'admin'} approval successfully`,
                routedTo,
                ...serializeVehicleState(driver),
            });
        }

        if (owned.length >= MAX_DRIVER_OWNED_VEHICLES) {
            return res.status(400).json({
                message: `You can register at most ${MAX_DRIVER_OWNED_VEHICLES} vehicles`,
                maxVehicles: MAX_DRIVER_OWNED_VEHICLES,
            });
        }

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

        const blockedRejected = getPendingOwnedVehicleRecord(driver);
        if (
            blockedRejected &&
            blockedRejected.approvalStatus === 'REJECTED' &&
            blockedRejected.allowDocumentResubmit === false
        ) {
            return res.status(403).json({
                message:
                    'This vehicle was rejected without document resubmit permission. Contact support or your vendor.',
            });
        }

        const newVehicle = {
            make,
            model,
            year: Number(year),
            color,
            licensePlate,
            vehicleType: vehicleType || 'cercaGlide',
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

        driver.vehicles.push(newVehicle);
        syncLegacyVehicleState(driver);
        driver.updatedAt = new Date();
        await driver.save();

        logger.info(`Driver vehicle info updated: ${driver.email}`);
        if (!driver.vendorId) {
            setImmediate(() => {
                notifyAdminsRegistrationEvent({
                    type: 'admin_vehicle_pending',
                    title: 'Vehicle pending approval',
                    message: `Driver ${driver.email || driverId}: vehicle ${licensePlate} submitted for admin approval.`,
                    entityKind: 'vehicle',
                    entityId: driverId,
                    path: '/folder/drivers',
                    data: {
                        licensePlate,
                        driverId: String(driverId),
                        source: 'driver_vehicle',
                    },
                }).catch((e) =>
                    logger.error('admin registration notify (driver vehicle):', e)
                );
            });
        }

        const routedTo = driver.vendorId ? 'VENDOR' : 'ADMIN';
        res.status(200).json({
            message: `Vehicle submitted for ${driver.vendorId ? 'vendor' : 'admin'} approval successfully`,
            routedTo,
            ...serializeVehicleState(driver),
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

        if (ride.status !== 'accepted' && ride.status !== 'upcoming') {
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

/**
 * @desc    Accept a ride (for push notification-based rides)
 * @route   POST /drivers/:driverId/rides/:rideId/accept
 */
const acceptRide = async (req, res) => {
    try {
        const { driverId, rideId } = req.params;

        const ride = await Ride.findById(rideId)
            .populate('rider', 'fullName name phone email')
            .select('+bookingType +bookingMeta');

        if (!ride) {
            return res.status(404).json({ message: 'Ride not found' });
        }

        if (ride.status !== 'requested') {
            return res.status(400).json({
                message: `Ride is already ${ride.status}`,
                status: ride.status
            });
        }

        // Check if driver can accept this ride type
        const driver = await Driver.findById(driverId);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const { driverCanAcceptRideType } = require('../../utils/ride_booking_functions');
        const canAccept = await driverCanAcceptRideType(driver, ride.vehicleType);
        if (!canAccept) {
            return res.status(403).json({
                message: 'You are not eligible to accept this type of ride'
            });
        }

        // Use Redis lock to prevent race conditions
        const { redis } = require('../../config/redis');
        const lockKey = `ride_lock:${rideId}`;
        const locked = await redis.set(lockKey, driverId, 'NX', 'EX', 15);

        if (!locked) {
            return res.status(409).json({
                message: 'This ride has already been accepted by another driver',
                code: 'RIDE_ALREADY_ACCEPTED'
            });
        }

        try {
            // Assign driver to ride
            const { assignDriverToRide } = require('../../utils/ride_booking_functions');
            const assignedRide = await assignDriverToRide(rideId, driverId, null); // No socket ID for API calls

            if (!assignedRide) {
                return res.status(500).json({
                    message: 'Failed to assign ride',
                    code: 'ASSIGNMENT_FAILED'
                });
            }

            // Emit socket events for the accepted ride
            const io = getSocketIO();
            const isFullDayBooking = assignedRide.bookingType === 'FULL_DAY';

            const rideWithMetadata = {
                ...(assignedRide.toObject ? assignedRide.toObject() : assignedRide),
                isFullDayBooking
            };

            const driverRidePayload = sanitizeRideContactsForDriver(rideWithMetadata);
            const roomName = `ride_${rideId}`;

            // Safely compute rider/driver identifiers
            const riderIdentifier = assignedRide && assignedRide.rider
                ? assignedRide.rider._id || assignedRide.rider
                : null;
            const driverIdentifier = assignedRide && assignedRide.driver
                ? assignedRide.driver._id || assignedRide.driver
                : null;

            // Force join ride room
            try {
                if (riderIdentifier) {
                    io.in(`user_${riderIdentifier}`).socketsJoin(roomName);
                }
                if (driverIdentifier) {
                    io.in(`driver_${driverIdentifier}`).socketsJoin(roomName);
                }
            } catch (e) {
                logger.warn('Auto-join to ride room failed', { err: e.message });
            }

            // Notify rider
            if (riderIdentifier) {
                try {
                    io.to(`user_${riderIdentifier}`).emit('rideAccepted', driverRidePayload);
                } catch (e) {
                    logger.warn('Emit rideAccepted to rider failed', { err: e.message });
                }
            }

            // Notify driver (use rideScheduled for intercity/scheduled rides)
            const shouldUseScheduledEvent = assignedRide.rideType === 'intercity' || assignedRide.scheduleType === 'scheduled';

            if (shouldUseScheduledEvent) {
                io.to(`driver_${driverIdentifier}`).emit('rideScheduled', driverRidePayload);
                logger.info(`Emitted rideScheduled to driver for ${assignedRide.rideType}/${assignedRide.scheduleType} ride - rideId: ${rideId}`);
            } else {
                io.to(`driver_${driverIdentifier}`).emit('rideAssigned', driverRidePayload);
            }

            // Broadcast to ride room
            io.to(roomName).emit('rideAccepted', driverRidePayload);

            // Notify admin
            io.to('admin').emit('rideStatusUpdated', {
                rideId,
                status: assignedRide.status,
                ride: rideWithMetadata
            });

            // Create notifications
            const passengerName = assignedRide.rideFor === 'OTHER'
                ? assignedRide.passenger?.name
                : assignedRide.rider?.fullName || assignedRide.rider?.name;

            await createNotification({
                recipientId: assignedRide.rider._id,
                recipientModel: 'User',
                title: 'Ride Accepted',
                message: `Your ride has been accepted by ${assignedRide.driver.name}`,
                type: 'ride_accepted',
                relatedRide: rideId
            });

            await createNotification({
                recipientId: driverId,
                recipientModel: 'Driver',
                title: 'Ride Accepted',
                message: 'You have accepted a new ride',
                type: 'ride_accepted',
                relatedRide: rideId
            });

            logger.info(`Ride accepted successfully via API - rideId: ${rideId}, driverId: ${driverId}`);

            return res.status(200).json({
                message: 'Ride accepted successfully',
                ride: driverRidePayload
            });

        } finally {
            // Release the lock
            try {
                await redis.del(lockKey);
            } catch (e) {
                logger.warn(`Failed to release ride lock for ${rideId}:`, e.message);
            }
        }

    } catch (error) {
        logger.error('Error accepting ride via API:', error);
        return res.status(500).json({
            message: 'Error accepting ride',
            error: error.message
        });
    }
};

const deleteDriverVehicle = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);

        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
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
            syncRideAccessState(fresh);
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
        syncRideAccessState(updated);
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

        const sub = driver.vehicles.id(vehicleId);
        if (!sub) {
            return res.status(404).json({ message: 'Vehicle not found on this driver' });
        }

        pushArchivedSnapshot(driver, sub);

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
        syncRideAccessState(driver);
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

/**
 * @desc    Restore a vehicle from archivedVehicles into the active garage (driver JWT)
 * @route   POST /drivers/:id/vehicles/restore
 */
const restoreGarageVehicleFromArchive = async (req, res) => {
    try {
        const { id } = req.params;
        const archiveId = req.body?.archiveId ?? req.body?.archive_id;
        if (!archiveId || typeof archiveId !== 'string') {
            return res.status(400).json({ message: 'archiveId is required' });
        }

        const driver = await Driver.findById(id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const arch = driver.archivedVehicles.id(archiveId);
        if (!arch) {
            return res.status(404).json({ message: 'Archived vehicle not found' });
        }

        if (getOwnedVehicleRecords(driver).length >= MAX_GARAGE_VEHICLES) {
            return res.status(400).json({ message: 'Garage is full' });
        }

        const hasPending = getOwnedVehicleRecords(driver).some(
            (v) => v.approvalStatus === 'UNDER_APPROVAL'
        );
        if (hasPending) {
            return res.status(400).json({
                message: 'Cannot restore while another vehicle is under review',
            });
        }

        const plainArch = toPlainVehicleRecord(arch);

        driver.archivedVehicles.pull({ _id: arch._id });

        const newVehicle = {
            make: plainArch.make,
            model: plainArch.model,
            year: plainArch.year,
            color: plainArch.color,
            licensePlate: plainArch.licensePlate,
            vehicleType: plainArch.vehicleType || 'sedan',
            documents: Array.isArray(plainArch.documents) ? [...plainArch.documents] : [],
            approvalStatus: plainArch.approvalStatus,
            approvalRoutedTo: plainArch.approvalRoutedTo ?? null,
            submittedAt: plainArch.submittedAt || new Date(),
            approvedAt: plainArch.approvedAt,
            rejectedAt: plainArch.rejectedAt,
            rejectionReason: plainArch.rejectionReason,
            allowDocumentResubmit: plainArch.allowDocumentResubmit ?? false,
            vendorPreApprovedAt: plainArch.vendorPreApprovedAt,
            approvedBy: plainArch.approvedBy ?? null,
            isActive: false,
        };

        if (newVehicle.approvalStatus === 'APPROVED') {
            getOwnedVehicleRecords(driver).forEach((v) => {
                if (v.approvalStatus === 'APPROVED') {
                    v.isActive = false;
                }
            });
            newVehicle.isActive = true;
        }

        driver.vehicles.push(newVehicle);
        driver.pendingVehicleInfo = null;
        syncLegacyVehicleState(driver);
        await driver.save();

        logger.info(`Driver restored garage vehicle from archive: ${driver.email} archiveId=${archiveId}`);
        return res.status(200).json({
            message: 'Vehicle restored to garage',
            ...serializeVehicleState(driver),
        });
    } catch (error) {
        logger.error('Error restoring garage vehicle from archive:', error);
        return res.status(500).json({
            message: 'Error restoring vehicle',
            error: error.message,
        });
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

        const allowDocumentResubmit = req.body?.allowDocumentResubmit !== false;
        await rejectPendingVehicleForDriver(driver, reason.trim(), allowDocumentResubmit);
        queueDriverVehicleRejectedEmail(driver, reason.trim(), 'ADMIN');
        queueVendorDriverVehicleNotificationEmail(
            driver,
            'Driver vehicle rejected',
            `Hi, driver ${driver.name || 'a driver'}'s vehicle has been rejected by Cerca admin. Reason: ${reason.trim()}`,
            'vendor_driver_vehicle_rejected'
        );

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

        const allowDocumentResubmit = req.body?.allowDocumentResubmit !== false;
        await rejectPendingVehicleForDriver(
            driver,
            reason.trim(),
            allowDocumentResubmit,
            req.params.vehicleId
        );
        queueDriverVehicleRejectedEmail(driver, reason.trim(), 'ADMIN');
        queueVendorDriverVehicleNotificationEmail(
            driver,
            'Driver vehicle rejected',
            `Hi, driver ${driver.name || 'a driver'}'s vehicle has been rejected by Cerca admin. Reason: ${reason.trim()}`,
            'vendor_driver_vehicle_rejected'
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
 * @desc    Enable/disable intercity availability
 * @route   PATCH /drivers/:id/intercity-toggle
 */
const updateDriverIntercityToggle = async (req, res) => {
    try {
        const { intercityEnabled } = req.body;

        if (typeof intercityEnabled !== 'boolean') {
            return res.status(400).json({ message: 'intercityEnabled must be a boolean value' });
        }

        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        if (intercityEnabled) {
            const standardRideCount = Number(driver.completedStandardRideCount || 0);

            if (standardRideCount < 50) {
                return res.status(400).json({
                    message: 'Intercity toggle can only be enabled after 50 completed standard rides',
                    completedStandardRides: standardRideCount,
                    requiredStandardRides: 50
                });
            }
        }

        const updatedDriver = await Driver.findByIdAndUpdate(
            driver._id,
            { intercityEnabled },
            { new: true }
        ).select('-password');

        logger.info(`Driver intercity toggle updated: ${driver.email}, intercityEnabled: ${intercityEnabled}`);
        res.status(200).json({
            message: 'Intercity toggle updated successfully',
            driver: updatedDriver
        });
    } catch (error) {
        logger.error('Error updating driver intercity toggle:', error);
        res.status(500).json({ message: 'Error updating driver intercity toggle', error });
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

        const wasRejected =
            getDriverApprovalSummary(driver).status === DRIVER_APPROVAL_STATUS.REJECTED;
        const submitForReview = req.body?.submitForReview === true;

        const complianceDocuments = Array.isArray(req.body.complianceDocuments)
            ? req.body.complianceDocuments
            : [];

        driver.complianceDocuments = syncComplianceStatuses(complianceDocuments);

        if (
            wasRejected &&
            (submitForReview || getMissingDriverApprovalDocuments(driver).length === 0)
        ) {
            setDriverPendingApproval(driver);
        }

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

const buildDriverResubmitProfileResponse = async (driver) => {
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

    return driverObj;
};

/**
 * @desc    Driver resubmits after REJECTED — reset workflow to PENDING_VENDOR / PENDING_ADMIN
 * @route   POST /drivers/:id/resubmit-approval (authenticated, own id only)
 * Idempotent: if already PENDING_VENDOR / PENDING_ADMIN, returns 200 with current profile.
 */
const resubmitDriverApproval = async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.id);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        const summary = getDriverApprovalSummary(driver);
        if (
            summary.status === DRIVER_APPROVAL_STATUS.PENDING_VENDOR ||
            summary.status === DRIVER_APPROVAL_STATUS.PENDING_ADMIN
        ) {
            const driverObj = await buildDriverResubmitProfileResponse(driver);
            return res.status(200).json(driverObj);
        }

        if (summary.status !== DRIVER_APPROVAL_STATUS.REJECTED) {
            return res.status(400).json({
                message: 'Resubmit is only available after your application was rejected',
                approvalStatus: summary.status,
            });
        }

        setDriverPendingApproval(driver);
        await driver.save();

        const driverObj = await buildDriverResubmitProfileResponse(driver);
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
    registerDriver,
    patchDriverProfilePhoto,
    deleteDriverProfilePhoto,
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
    acceptRide,
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
    restoreGarageVehicleFromArchive,
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
    updateDriverIntercityToggle,
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
