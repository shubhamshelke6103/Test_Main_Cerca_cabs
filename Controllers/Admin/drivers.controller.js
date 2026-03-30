const path = require('path');
const Driver = require('../../Models/Driver/driver.model');
const Ride = require('../../Models/Driver/ride.model');
const Payout = require('../../Models/Driver/payout.model');
const AdminEarnings = require('../../Models/Admin/adminEarnings.model');
const logger = require('../../utils/logger');
const { deleteDriverDocuments } = require('../../utils/driverDocument.service');
const { getFleetOnlineHoursSummary } = require('../../utils/driverSession.service');
const {
  REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES,
  getMissingDriverApprovalDocuments,
  adminApproveDriver,
  rejectDriverApproval,
  getDriverApprovalSummary,
  DRIVER_APPROVAL_ACTOR,
  setDriverPendingApproval,
} = require('../../utils/driverApproval.service');

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
};

const resolveVehicleStatus = (driver) => (
  driver.pendingVehicleInfo?.approvalStatus || (driver.vehicleInfo ? 'APPROVED' : 'NOT_ADDED')
);

const serializeDriverForResponse = (driver) => ({
  ...driver.toObject(),
  vehicleStatus: resolveVehicleStatus(driver),
  approvalStatus: getDriverApprovalSummary(driver).status,
  approvalWorkflow: getDriverApprovalSummary(driver),
});

const VEHICLE_STATUS_VALUES = ['UNDER_APPROVAL', 'REJECTED', 'APPROVED', 'NOT_ADDED'];

const applyAdminVehicleListFilter = (query, { vehiclePending, vehicleStatus }) => {
  const pendingFlag = vehiclePending === true;
  const status = typeof vehicleStatus === 'string' ? vehicleStatus.toUpperCase() : '';

  if (pendingFlag || status === 'UNDER_APPROVAL') {
    query['pendingVehicleInfo.approvalStatus'] = 'UNDER_APPROVAL';
    query['pendingVehicleInfo.approvalRoutedTo'] = 'ADMIN';
    return;
  }

  if (status === 'REJECTED') {
    query['pendingVehicleInfo.approvalStatus'] = 'REJECTED';
    query['pendingVehicleInfo.approvalRoutedTo'] = 'ADMIN';
    return;
  }

  if (status === 'APPROVED') {
    query.vehicleInfo = { $exists: true, $ne: null };
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
    } = req.query;
    const query = {};
    // by default hide drivers that belong to a vendor (only show standalone drivers)
    if (!parseBoolean(includeVendor)) {
      query.vendorId = null; // vendors drivers have this field set when assigned
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
    const earningsSummary = await AdminEarnings.aggregate([
      { $match: { driverId: { $in: driverIds } } },
      {
        $group: {
          _id: '$driverId',
          totalEarnings: { $sum: '$driverEarning' }
        }
      }
    ]);

    const earningsMap = earningsSummary.reduce((acc, item) => {
      acc[item._id.toString()] = item.totalEarnings || 0;
      return acc;
    }, {});

    const driversWithEarnings = drivers.map((driver) => ({
      ...serializeDriverForResponse(driver),
      totalEarnings: Math.round((earningsMap[driver._id.toString()] || 0) * 100) / 100,
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
    const driver = await Driver.findById(id);

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const [rides, payouts] = await Promise.all([
      Ride.find({ driver: id }).sort({ createdAt: -1 }).limit(20),
      Payout.find({ driver: id }).sort({ requestedAt: -1 }).limit(20),
    ]);

    res.status(200).json({
      driver: serializeDriverForResponse(driver),
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
    const driver = await Driver.findById(id).select('complianceDocuments vendorId approvalWorkflow isVerified isActive rejectionReason createdAt');

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

    res.status(200).json({
      message: 'Driver approved',
      driver: serializeDriverForResponse(driver),
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

    res.status(200).json({
      message: 'Driver rejected',
      driver: serializeDriverForResponse(driver),
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

    const driver = await Driver.findById(id).select('complianceDocuments vendorId approvalWorkflow isVerified isActive rejectionReason createdAt');

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
    } else {
      setDriverPendingApproval(driver);
      await driver.save();
    }

    res.status(200).json({
      message: 'Driver verification updated',
      driver: serializeDriverForResponse(driver),
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

    const raw = driver.documents || [];
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const documents = raw.map((doc) => {
      if (typeof doc !== 'string') return doc;
      if (/^https?:\/\//i.test(doc)) return doc;
      const path = doc.startsWith('/') ? doc : `/${doc}`;
      return `${baseUrl}${path}`;
    });

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

