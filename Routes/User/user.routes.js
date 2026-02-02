const express = require('express');
const { getAllUsers, getUserById, createUser, updateUser, deleteUser, loginUserByMobile, getUserWallet, updateUserWallet, validateToken } = require('../../Controllers/User/user.controller.js');

const router = express.Router();

// Specific routes MUST come before parameterized routes to avoid conflicts
// GET /users/validate-token - Validate JWT token (must be before /:id)
router.get('/validate-token', validateToken);

// POST /users/login - Login user
router.post('/login', loginUserByMobile);

// POST /users - Create user
router.post('/', createUser);

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

module.exports = router;
