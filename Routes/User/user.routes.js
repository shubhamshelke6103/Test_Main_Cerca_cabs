const express = require('express');
const multer = require('multer');
const path = require('path');
const { getAllUsers, getPrivacyPolicy, acceptPrivacyPolicy, getUserById, createUser, updateUser, deleteUser, loginUserByMobile, getUserWallet, updateUserWallet, validateToken, getOutstandingDriverCancelSettlements, updateUserFcmToken } = require('../../Controllers/User/user.controller.js');
const {
  getPendingDues,
  checkBookingEligibility,
  payPendingDuesWallet,
  createPendingDuesRazorpayOrder,
  verifyPendingDuesRazorpay,
  uploadRiderEvidence,
  listRiderDisputes,
} = require('../../Controllers/User/paymentDispute.controller.js');

const disputeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) =>
      cb(null, `dispute-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = express.Router();

// Specific routes MUST come before parameterized routes to avoid conflicts
// GET /users/validate-token - Validate JWT token (must be before /:id)
router.get('/validate-token', validateToken);
router.get('/privacy-policy', getPrivacyPolicy);
router.post('/privacy-policy/accept', acceptPrivacyPolicy);

// POST /users/login - Login user
router.post('/login', loginUserByMobile);

// POST /users - Create user
router.post('/', createUser);

// Pending driver in-progress cancel charges (must be before GET /:id)
router.get(
  '/:id/outstanding-driver-cancel-settlements',
  getOutstandingDriverCancelSettlements
);

// Payment dispute / pending dues (must be before GET /:id)
router.get('/:id/pending-dues', getPendingDues);
router.get('/:id/booking-eligibility', checkBookingEligibility);
router.post('/:id/pending-dues/pay-wallet', payPendingDuesWallet);
router.post('/:id/pending-dues/pay-online', createPendingDuesRazorpayOrder);
router.post('/:id/pending-dues/verify-payment', verifyPendingDuesRazorpay);
router.get('/:id/payment-disputes', listRiderDisputes);
router.post(
  '/:id/payment-disputes/:disputeId/evidence',
  disputeUpload.single('file'),
  uploadRiderEvidence
);

// Parameterized routes - these should come after specific routes
// GET /users/:id - Get user by ID
router.get('/:id', getUserById);

// PUT /users/:id - Update user
router.put('/:id', updateUser);

// DELETE /users/:id - Delete user
router.delete('/:id', deleteUser);

// Wallet routes - these use :id parameter but are more specific
// GET /users/:id/wallet - Get user wallet
router.get('/:id/wallet', getUserWallet);

// PUT /users/:id/wallet - Update user wallet
router.put('/:id/wallet', updateUserWallet);

// PATCH /users/:id/fcm-token - Persist (or clear) the rider's FCM device token
router.patch('/:id/fcm-token', updateUserFcmToken);

module.exports = router;
