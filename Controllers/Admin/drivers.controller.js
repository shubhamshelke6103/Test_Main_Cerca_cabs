const path = require('path');
const Driver = require('../../Models/Driver/driver.model');
const Vendor = require('../../Models/vendor/vendor.models');
const Ride = require('../../Models/Driver/ride.model');
const Payout = require('../../Models/Driver/payout.model');
const AdminEarnings = require('../../Models/Admin/adminEarnings.model');
const logger = require('../../utils/logger');
const { deleteDriverDocuments } = require('../../utils/driverDocument.service');
const { getFleetOnlineHoursSummary } = require('../../utils/driverSession.service');
const { queueExternalAlertEmail } = require('../../utils/alerting.service');
const {
  REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES,
  getMissingDriverApprovalDocuments,
  adminApproveDriver,
  rejectDriverApproval,
  getDriverApprovalSummary,
  DRIVER_APPROVAL_ACTOR,
  setDriverPendingApproval,
} = require('../../utils/driverApproval.service');
const { resolveAggregateVehicleStatus: resolveVehicleStatus } = require('../../utils/driverVehicleAggregateStatus.js');

const normalizeStoredDocumentUrl = (req, url) => {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return rawUrl;

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const normalizedPath = rawUrl.replace(/\\/g, '/');
  const uploadsIndex = normalizedPath.lastIndexOf('/uploads/');

  if (uploadsIndex >= 0) {
    return `${baseUrl}${normalizedPath.slice(uploadsIndex)}`;
  }

  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }

  if (normalizedPath.startsWith('uploads/')) {
    return `${baseUrl}/${normalizedPath}`;
  }

  if (normalizedPath.startsWith('/uploads/')) {
    return `${baseUrl}${normalizedPath}`;
  }

  return normalizedPath;
};

const normalizeVehicleDocuments = (vehicleInfo, req) => {
  if (!vehicleInfo || !Array.isArray(vehicleInfo.documents)) {
    return vehicleInfo || null;
  }

  return {
    ...vehicleInfo,
    documents: vehicleInfo.documents.map((doc) => ({
      ...doc,
      documentUrl: normalizeStoredDocumentUrl(req, doc.documentUrl),
    })),
  };
};

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
};

const queueDriverApprovalEmail = (driver) => {
  if (!driver?.email) return;

  setImmediate(async () => {
    try {
      await queueExternalAlertEmail({
        channel: 'email',
        to: driver.email,
        subject: 'Driver account approved',
        message: `Hi ${driver.name || 'Driver'}, your driver account has been approved by Cerca admin. You can now access the driver app and start accepting rides.`,
        metadata: {
          purpose: 'driver_account_approved',
          driverId: driver._id,
          actor: 'ADMIN',
        },
      });
    } catch (emailErr) {
      logger.error(`Driver approval email queue error for ${driver.email}: ${emailErr.message}`);
    }
  });
};

const queueDriverRejectionEmail = (driver, reason) => {
  if (!driver?.email) return;

  setImmediate(async () => {
    try {
      await queueExternalAlertEmail({
        channel: 'email',
        to: driver.email,
        subject: 'Driver account rejected',
        message: `Hi ${driver.name || 'Driver'}, your driver account application has been rejected by Cerca admin. Reason: ${reason || 'No reason provided'}. Please contact support to resolve any issues.`,
        metadata: {
          purpose: 'driver_account_rejected',
          driverId: driver._id,
          actor: 'ADMIN',
        },
      });
    } catch (emailErr) {
      logger.error(`Driver rejection email queue error for ${driver.email}: ${emailErr.message}`);
    }
  });
};

const queueVendorDriverNotificationEmail = (driver, subject, message, purpose) => {
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
      logger.error(`Vendor notification email queue error for driver ${driver._id}: ${emailErr.message}`);
    }
  });
};

const DOCUMENT_TYPE_LABELS = {
  AADHAAR_CARD: 'Aadhaar Card',
  PAN_CARD: 'PAN Card',
  DRIVING_LICENSE: 'Driving License',
  GST_CERTIFICATE: 'GST Certificate',
  BUSINESS_LICENSE: 'Business License',
  PASSPORT: 'Passport',
  VOTER_ID: 'Voter ID',
  DOCUMENT: 'Document',
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

  const documentType = normalizeDocumentTypeKey(
    rawDocument.documentType || inferDocumentTypeFromName(rawUrl)
  );

  return {
    documentType: documentType || null,
    documentName: getDocumentDisplayName(documentType, rawUrl, index),
    documentUrl,
  };
};

const buildVehicleSummaryKey = (snapshot) => {
  if (!snapshot) return 'UNKNOWN_VEHICLE';
  if (snapshot.licensePlate) return `LICENSE:${String(snapshot.licensePlate).toUpperCase()}`;
  const fallbackKeyParts = [
    snapshot.make || 'UNKNOWN',
    snapshot.model || 'UNKNOWN',
    snapshot.year || 'NA',
    snapshot.vehicleType || 'UNKNOWN',
  ];
  return `VEHICLE:${fallbackKeyParts.join('|').toUpperCase()}`;
};

const buildAdminVehicleSnapshotFallback = (driver) => {
  const vehicles = Array.isArray(driver?.vehicles) ? driver.vehicles : [];
  const activeVehicle =
    vehicles.find((vehicle) => vehicle.approvalStatus === 'APPROVED' && vehicle.isActive) ||
    [...vehicles].reverse().find((vehicle) => vehicle.approvalStatus === 'APPROVED');

  const vehicleInfo = activeVehicle || driver?.vehicleInfo || null;
  if (vehicleInfo) {
    return {
      licensePlate: vehicleInfo.licensePlate || null,
      make: vehicleInfo.make || null,
      model: vehicleInfo.model || null,
      year: vehicleInfo.year || null,
      color: vehicleInfo.color || null,
      vehicleType: vehicleInfo.vehicleType || null,
      source: driver?.assignedFleetVehicleId ? 'FLEET_ASSIGNED' : 'SELF_OWNED',
    };
  }

  return {
    licensePlate: null,
    make: null,
    model: null,
    year: null,
    color: null,
    vehicleType: null,
    source: 'UNKNOWN',
  };
};

const buildAdminDriverRevenueMetrics = ({ driver, earnings = [] }) => {
  const vehicleMap = new Map();

  for (const earning of earnings) {
    const snapshot = earning.vehicleSnapshot?.licensePlate ||
      earning.vehicleSnapshot?.make ||
      earning.vehicleSnapshot?.model
      ? earning.vehicleSnapshot
      : buildAdminVehicleSnapshotFallback(driver);

    const key = buildVehicleSummaryKey(snapshot);
    if (!vehicleMap.has(key)) {
      vehicleMap.set(key, {
        vehicleKey: key,
        licensePlate: snapshot.licensePlate || null,
        make: snapshot.make || null,
        model: snapshot.model || null,
        year: snapshot.year || null,
        color: snapshot.color || null,
        vehicleType: snapshot.vehicleType || null,
        vehicleSource: snapshot.source || 'UNKNOWN',
        rideCount: 0,
        grossRevenue: 0,
        driverEarning: 0,
        vehicleProfit: 0,
      });
    }

    const current = vehicleMap.get(key);
    current.rideCount += 1;
    current.grossRevenue += Number(earning.grossFare) || 0;
    current.driverEarning += Number(earning.driverEarning) || 0;
    current.vehicleProfit += Number(earning.platformFee) || 0;
  }

  const totalDriverEarnings = earnings.reduce(
    (sum, earning) => sum + (Number(earning.driverEarning) || 0),
    0
  );
  const totalVehicleProfit = earnings.reduce(
    (sum, earning) => sum + (Number(earning.platformFee) || 0),
    0
  );

  return {
    earningsSummary: {
      totalDriverEarnings: Math.round(totalDriverEarnings * 100) / 100,
      totalVehicleProfit: Math.round(totalVehicleProfit * 100) / 100,
      totalRides: earnings.length,
    },
    vehicleProfitBreakdown: Array.from(vehicleMap.values()).map((item) => ({
      ...item,
      grossRevenue: Math.round(item.grossRevenue * 100) / 100,
      driverEarning: Math.round(item.driverEarning * 100) / 100,
      vehicleProfit: Math.round(item.vehicleProfit * 100) / 100,
    })),
  };
};

const serializeDriverForResponse = (driver, req) => {
  const serializedDriver = driver.toObject();

  return {
    ...serializedDriver,
    pendingVehicleInfo: normalizeVehicleDocuments(serializedDriver.pendingVehicleInfo, req),
    vehicles: Array.isArray(serializedDriver.vehicles)
      ? serializedDriver.vehicles.map((vehicle) => normalizeVehicleDocuments(vehicle, req))
      : [],
    vehicleStatus: resolveVehicleStatus(driver),
    approvalStatus: getDriverApprovalSummary(driver).status,
    approvalWorkflow: getDriverApprovalSummary(driver),
    missingDocuments: getMissingDriverApprovalDocuments(driver),
  };
};

const VEHICLE_STATUS_VALUES = ['UNDER_APPROVAL', 'REJECTED', 'APPROVED', 'NOT_ADDED'];

const APPROVAL_STATUS_QUERY_VALUES = [
  'PENDING_VENDOR',
  'PENDING_ADMIN',
  'APPROVED',
  'REJECTED',
];

const applyAdminVehicleListFilter = (query, { vehiclePending, vehicleStatus }) => {
  const pendingFlag = vehiclePending === true;
  const status = typeof vehicleStatus === 'string' ? vehicleStatus.toUpperCase() : '';

  if (pendingFlag || status === 'UNDER_APPROVAL') {
    query.$or = [
      {
        pendingVehicleInfo: { $exists: true, $ne: null },
        'pendingVehicleInfo.approvalStatus': 'UNDER_APPROVAL',
        'pendingVehicleInfo.approvalRoutedTo': 'ADMIN',
      },
      {
        vehicles: {
          $elemMatch: {
            approvalStatus: 'UNDER_APPROVAL',
            approvalRoutedTo: 'ADMIN',
          },
        },
      },
    ];
    return;
  }

  if (status === 'REJECTED') {
    query['pendingVehicleInfo.approvalStatus'] = 'REJECTED';
    query['pendingVehicleInfo.approvalRoutedTo'] = 'ADMIN';
    return;
  }

  if (status === 'APPROVED') {
    query.$or = [
      { vehicleInfo: { $exists: true, $ne: null } },
      { assignedFleetVehicleId: { $exists: true, $ne: null } },
    ];
    return;
  }

  if (status === 'NOT_ADDED') {
    query.$and = query.$and || [];
    query.$and.push({
      $or: [{ vehicleInfo: null }, { vehicleInfo: { $exists: false } }],
    });
    query.$and.push({
      $or: [
        { pendingVehicleInfo: null },
        { pendingVehicleInfo: { $exists: false } },
      ],
    });
  }
};

const listDrivers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      isActive,
      isVerified,
      isOnline,
      includeVendor,
      priorityPending,
      vehiclePending,
      vehicleStatus,
      approvalStatus,
    } = req.query;
    const query = {};

    const approvalStatusFilter =
      typeof approvalStatus === 'string' ? approvalStatus.trim().toUpperCase() : '';

    const includeVendorBool = parseBoolean(includeVendor) === true;
    const approvalNeedsVendorScope =
      approvalStatusFilter === 'PENDING_ADMIN' || approvalStatusFilter === 'PENDING_VENDOR';

    // Vendor-linked drivers are omitted unless includeVendor=true, or when filtering by
    // vendor workflow queues (those documents always have vendorId set).
    if (!includeVendorBool && !approvalNeedsVendorScope) {
      query.vendorId = null;
    }

    if (
      approvalStatusFilter &&
      APPROVAL_STATUS_QUERY_VALUES.includes(approvalStatusFilter)
    ) {
      query['approvalWorkflow.status'] = approvalStatusFilter;
    }

    const activeValue = parseBoolean(isActive);
    if (activeValue !== undefined) query.isActive = activeValue;

    const verifiedValue = parseBoolean(isVerified);
    if (verifiedValue !== undefined) query.isVerified = verifiedValue;

    const onlineValue = parseBoolean(isOnline);
    if (onlineValue !== undefined) query.isOnline = onlineValue;

    const vs = typeof vehicleStatus === 'string' ? vehicleStatus.toUpperCase() : '';
    const vehiclePendingTrue = parseBoolean(vehiclePending) === true;
    if (vehiclePendingTrue || (vs && VEHICLE_STATUS_VALUES.includes(vs))) {
      applyAdminVehicleListFilter(query, { vehiclePending: vehiclePendingTrue, vehicleStatus: vs });
    }

    if (parseBoolean(priorityPending)) {
      query.priorityDocument = { $exists: true, $ne: null, $ne: '' };
      query.isPriorityDriver = false;
    }

    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [drivers, total] = await Promise.all([
      Driver.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit, 10)),
      Driver.countDocuments(query),
    ]);

    const driverIds = drivers.map((driver) => driver._id);
    const earnings = driverIds.length
      ? await AdminEarnings.find({ driverId: { $in: driverIds } })
          .select('driverId grossFare platformFee driverEarning vehicleSnapshot')
          .lean()
      : [];

    const earningsMap = earnings.reduce((acc, item) => {
      const key = item.driverId.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});

    const driversWithEarnings = drivers.map((driver) => ({
      ...serializeDriverForResponse(driver, req),
      totalEarnings: Math.round(
        (earningsMap[driver._id.toString()] || []).reduce(
          (sum, earning) => sum + (Number(earning.driverEarning) || 0),
          0
        ) * 100
      ) / 100,
      ...buildAdminDriverRevenueMetrics({
        driver,
        earnings: earningsMap[driver._id.toString()] || [],
      }),
    }));

    res.status(200).json({
      drivers: driversWithEarnings,
      pagination: {
        currentPage: parseInt(page, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
        total,
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    logger.error('Error fetching drivers:', error);
    res.status(500).json({ message: 'Error fetching drivers', error: error.message });
  }
};

const getDriverDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const driver = await Driver.findById(id).populate({
      path: 'vendorId',
      select:
        'businessName ownerName email phone address isVerified isActive vendorReviewStatus rejectionReason allowDocumentResubmit commissionType commissionValue walletBalance totalEarnings totalRides',
    });

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const [rides, payouts, earnings] = await Promise.all([
      Ride.find({ driver: id }).sort({ createdAt: -1 }).limit(20),
      Payout.find({ driver: id }).sort({ requestedAt: -1 }).limit(20),
      AdminEarnings.find({ driverId: id })
        .select('driverId grossFare platformFee driverEarning vehicleSnapshot')
        .lean(),
    ]);

    res.status(200).json({
      driver: {
        ...serializeDriverForResponse(driver, req),
        ...buildAdminDriverRevenueMetrics({ driver, earnings }),
      },
      rides,
      payouts,
    });
  } catch (error) {
    logger.error('Error fetching driver details:', error);
    res.status(500).json({ message: 'Error fetching driver details', error: error.message });
  }
};

const approveDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const driver = await Driver.findById(id).select('email complianceDocuments vendorId approvalWorkflow isVerified isActive rejectionReason createdAt');

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const missingDocuments = getMissingDriverApprovalDocuments(driver);
    if (missingDocuments.length > 0) {
      return res.status(400).json({
        message: `Driver approval requires ${REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES.join(', ')} compliance documents`,
        missingDocuments,
      });
    }

    adminApproveDriver(driver);
    await driver.save();
    queueDriverApprovalEmail(driver);
    queueVendorDriverNotificationEmail(
      driver,
      'Driver approved',
      `Hi ${driver.name || 'Driver'}'s account has been approved by Cerca admin.`,
      'vendor_driver_approved'
    );

    res.status(200).json({
      message: 'Driver approved',
      driver: serializeDriverForResponse(driver, req),
    });
  } catch (error) {
    logger.error('Error approving driver:', error);
    const statusCode = error.message.includes('Vendor approval must be completed') ? 400 : 500;
    res.status(statusCode).json({ message: 'Error approving driver', error: error.message });
  }
};

const rejectDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const reason = req.body?.reason;
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }
    const driver = await Driver.findById(id);

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    deleteDriverDocuments(driver.documents || []);
    driver.documents = [];
    rejectDriverApproval(driver, DRIVER_APPROVAL_ACTOR.ADMIN, reason.trim());
    await driver.save();
    queueDriverRejectionEmail(driver, reason.trim());
    queueVendorDriverNotificationEmail(
      driver,
      'Driver rejected',
      `Hi, driver ${driver.name || driver._id} has been rejected by Cerca admin. Reason: ${reason.trim()}`,
      'vendor_driver_rejected'
    );

    res.status(200).json({
      message: 'Driver rejected',
      driver: serializeDriverForResponse(driver, req),
    });
  } catch (error) {
    logger.error('Error rejecting driver:', error);
    const statusCode = error.message.includes('pending admin approval') ? 400 : 500;
    res.status(statusCode).json({ message: 'Error rejecting driver', error: error.message });
  }
};

const blockDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const activeValue = parseBoolean(isActive);
    if (activeValue === undefined) {
      return res.status(400).json({ message: 'isActive must be true or false' });
    }

    const driver = await Driver.findByIdAndUpdate(
      id,
      { isActive: activeValue },
      { new: true }
    );

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    res.status(200).json({ message: 'Driver status updated', driver });
  } catch (error) {
    logger.error('Error updating driver status:', error);
    res.status(500).json({ message: 'Error updating driver status', error: error.message });
  }
};

const verifyDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { isVerified } = req.body;

    const verifiedValue = parseBoolean(isVerified);
    if (verifiedValue === undefined) {
      return res.status(400).json({ message: 'isVerified must be true or false' });
    }

    const driver = await Driver.findById(id).select('email complianceDocuments vendorId approvalWorkflow isVerified isActive rejectionReason createdAt');

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    if (verifiedValue === true) {
      const missingDocuments = getMissingDriverApprovalDocuments(driver);
      if (missingDocuments.length > 0) {
        return res.status(400).json({
          message: `Driver verification requires ${REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES.join(', ')} compliance documents`,
          missingDocuments,
        });
      }

      adminApproveDriver(driver);
      await driver.save();
      queueDriverApprovalEmail(driver);
      queueVendorDriverNotificationEmail(
        driver,
        'Driver approved',
        `Hi, driver ${driver.name || driver._id} has been approved by Cerca admin.`,
        'vendor_driver_approved'
      );
    } else {
      setDriverPendingApproval(driver);
      await driver.save();
    }

    res.status(200).json({
      message: 'Driver verification updated',
      driver: serializeDriverForResponse(driver, req),
    });
  } catch (error) {
    logger.error('Error verifying driver:', error);
    const statusCode = error.message.includes('pending admin approval') || error.message.includes('Vendor approval must be completed')
      ? 400
      : 500;
    res.status(statusCode).json({ message: 'Error verifying driver', error: error.message });
  }
};

const getDriverDocuments = async (req, res) => {
  try {
    const { id } = req.params;
    const driver = await Driver.findById(id).select('documents');

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const documents = (driver.documents || []).map((document, index) =>
      normalizeStoredDocumentEntry(req, document, index)
    );

    res.status(200).json({ documents });
  } catch (error) {
    logger.error('Error fetching driver documents:', error);
    res.status(500).json({ message: 'Error fetching driver documents', error: error.message });
  }
};

const getPriorityDocument = async (req, res) => {
  try {
    const { id } = req.params;
    const driver = await Driver.findById(id).select('priorityDocument');

    if (!driver || !driver.priorityDocument) {
      return res.status(404).json({ message: 'Priority document not found' });
    }

    const stored = driver.priorityDocument;
    let filePath;

    if (/^https?:\/\//i.test(stored)) {
      try {
        const u = new URL(stored);
        const pathname = u.pathname.replace(/^\//, '');
        filePath = path.join(process.cwd(), pathname);
      } catch (e) {
        return res.status(400).json({ message: 'Invalid priority document URL' });
      }
    } else {
      filePath = path.join(process.cwd(), stored);
    }

    const resolvedPath = path.resolve(filePath);
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    if (!resolvedPath.startsWith(uploadsDir)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(resolvedPath);
  } catch (error) {
    logger.error('Error serving priority document:', error);
    res.status(500).json({ message: 'Error serving priority document', error: error.message });
  }
};

const getFleetOnlineHoursReport = async (req, res) => {
  try {
    const { period = 'daily', startDate, endDate, vendorId } = req.query;
    const now = new Date();
    const rangeStart = startDate ? new Date(startDate) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rangeEnd = endDate ? new Date(endDate) : now;

    const driverFilter = {};
    if (vendorId) driverFilter.vendorId = vendorId;
    const drivers = await Driver.find(driverFilter).select('_id name vendorId').lean();
    const driverIds = drivers.map((driver) => driver._id);

    if (driverIds.length === 0) {
      return res.status(200).json({
        success: true,
        summary: [],
        totalMinutes: 0,
        totalSessions: 0,
        drivers: [],
      });
    }

    const report = await getFleetOnlineHoursSummary({
      driverIds,
      startDate: rangeStart,
      endDate: rangeEnd,
      groupBy: period,
    });

    const driverBreakdown = drivers.map((driver) => {
      const item = report.driverBreakdown[String(driver._id)] || { totalMinutes: 0, sessionCount: 0 };
      return {
        id: driver._id,
        name: driver.name,
        vendorId: driver.vendorId || null,
        totalMinutes: item.totalMinutes || 0,
        sessionCount: item.sessionCount || 0,
      };
    });

    return res.status(200).json({
      success: true,
      period,
      startDate: rangeStart,
      endDate: rangeEnd,
      summary: report.summary,
      totalMinutes: report.totalMinutes,
      totalSessions: report.totalSessions,
      drivers: driverBreakdown,
    });
  } catch (error) {
    logger.error('Error fetching fleet online hours report:', error);
    return res.status(500).json({ message: 'Error fetching fleet online hours report', error: error.message });
  }
};

module.exports = {
  listDrivers,
  getDriverDetails,
  approveDriver,
  rejectDriver,
  blockDriver,
  verifyDriver,
  getDriverDocuments,
  getPriorityDocument,
  getFleetOnlineHoursReport,
};

