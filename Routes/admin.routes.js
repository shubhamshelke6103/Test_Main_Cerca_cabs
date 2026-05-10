const express =  require('express');
const { authLimiter } = require('../middleware/rateLimiter');
const {
    createAdmin,
    createSubAdmin,
    getAllSubAdmins,
    deleteSubAdmin,
    adminLogin,
    changeAdminPassword,
    getAdminEarnings,
} = require('../Controllers/admin.controller.js');
const {
    getSettings,
    updateSettings,
    toggleMaintenanceMode,
    toggleForceUpdate,
    addSettings,
    getVehicleServices,
    getPublicSettings,
    getSystemSettings,
} = require('../Controllers/adminSettings.controller.js');
const {
    listDriverEarnings,
    getDriverEarningsById,
    updateEarningStatus,
    bulkUpdateEarningStatus,
    getEarningsStats,
    getEarningsAnalytics,
    listCashReceivables,
    collectCashPlatformReceivable,
} = require('../Controllers/Admin/driverEarnings.controller.js');
const {
    verifyRideEarnings,
    verifyDriverEarnings,
    findMissingEarningsRecords,
    triggerBackfill,
    findIncorrectEarningsRecords,
    validateTotals,
} = require('../Controllers/Admin/earningsVerification.controller.js');
const { listVehicleInventory } = require('../Controllers/Admin/fleetVehicle.controller');
const {
  listAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} = require('../Controllers/Admin/adminNotifications.controller.js');

const { authenticateAdmin, requireRole } = require('../utils/adminAuth');

const router = express.Router();

// Admin login (public)
router.post('/login', adminLogin);

// Create admin (public for initial setup, or protected for ADMIN role)
// Note: For production, consider adding additional security (e.g., secret key check)
router.post('/create-admin', createAdmin);

// Public routes for user app (no authentication required)
router.get('/settings/vehicle-services', getVehicleServices);
router.get('/settings/public', getPublicSettings);
router.get('/settings/system', getSystemSettings);

// Protected admin routes
router.use(authenticateAdmin);

// Routes for admin management
router.post('/', requireRole(['ADMIN']), createSubAdmin);
router.get('/', requireRole(['ADMIN']), getAllSubAdmins);
router.delete('/:id', requireRole(['ADMIN']), deleteSubAdmin);
router.post('/change-password', authLimiter, changeAdminPassword);

// Routes for settings
router.post('/settings', addSettings);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.patch('/settings/maintenance-mode', toggleMaintenanceMode);
router.patch('/settings/force-update', toggleForceUpdate);

// Route for admin earnings analytics
router.get('/earnings', getAdminEarnings);
router.get('/vehicles', listVehicleInventory);

// Routes for driver earnings management
router.get('/drivers/earnings', listDriverEarnings);
router.get('/drivers/earnings/stats', getEarningsStats);
router.get('/drivers/earnings/analytics', getEarningsAnalytics);
router.get('/drivers/cash-receivables', listCashReceivables);
router.get('/drivers/:driverId/earnings', getDriverEarningsById);
router.patch('/drivers/earnings/:earningId/cash-platform-collect', collectCashPlatformReceivable);
router.patch('/drivers/earnings/:earningId/status', updateEarningStatus);
router.patch('/drivers/earnings/bulk-status', bulkUpdateEarningStatus);

// Routes for earnings verification
router.post('/earnings/verify-ride/:rideId', verifyRideEarnings);
router.post('/earnings/verify-driver/:driverId', verifyDriverEarnings);
router.post('/earnings/find-missing', findMissingEarningsRecords);
router.post('/earnings/backfill', triggerBackfill);
router.post('/earnings/find-incorrect', findIncorrectEarningsRecords);
router.post('/earnings/validate-totals', validateTotals);

// In-app notifications (JWT admin only; scoped to authenticated admin)
router.get('/notifications', listAdminNotifications);
router.patch('/notifications/:id/read', markAdminNotificationRead);
router.patch('/notifications/read-all', markAllAdminNotificationsRead);

module.exports = router;
