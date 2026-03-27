// import User from '../../Models/User/user.model.js';
// import jwt from 'jsonwebtoken';
// import logger from '../../utils/logger.js';
// import fs from 'fs';
// import path from 'path';

const User = require('../../Models/User/user.model');
const jwt = require('jsonwebtoken');
const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');

const PRIVACY_POLICY_VERSION = process.env.PRIVACY_POLICY_VERSION || '2026-03-23';
const PRIVACY_POLICY_URL = process.env.PRIVACY_POLICY_URL || '/privacy-policy';
const JWT_SECRET =
    process.env.JWT_SECRET ||
    "@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%";

const parseBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return false;
};

const getPrivacyPolicyMetadata = () => ({
    version: PRIVACY_POLICY_VERSION,
    url: PRIVACY_POLICY_URL,
});

const buildPrivacyPolicyAcceptance = (payload = {}) => {
    const accepted = parseBoolean(payload.privacyPolicyAccepted);

    if (!accepted) {
        return {
            error: {
                message: 'Privacy policy acceptance is required during registration',
                privacyPolicy: getPrivacyPolicyMetadata(),
            },
        };
    }

    return {
        privacyPolicyAccepted: true,
        privacyPolicyAcceptedAt: new Date(),
        privacyPolicyVersion: payload.privacyPolicyVersion || PRIVACY_POLICY_VERSION,
        privacyPolicyUrl: payload.privacyPolicyUrl || PRIVACY_POLICY_URL,
    };
};

const getPrivacyPolicy = async (req, res) => {
    return res.status(200).json({
        success: true,
        privacyPolicy: getPrivacyPolicyMetadata(),
    });
};

const acceptPrivacyPolicy = async (req, res) => {
    try {
        const authHeader = req.headers.authorization || req.headers.Authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authentication required' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id || decoded.userId;
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const acceptance = buildPrivacyPolicyAcceptance(req.body);
        if (acceptance.error) {
            return res.status(400).json(acceptance.error);
        }
        Object.assign(user, acceptance);
        await user.save();
        return res.status(200).json({
            success: true,
            message: 'Privacy policy accepted successfully',
            privacyPolicy: getPrivacyPolicyMetadata(),
        });
    } catch (error) {
        logger.error('Error accepting privacy policy:', error);
        return res.status(500).json({ message: 'Error accepting privacy policy', error: error.message });
    }
};

/**
 * @desc    Get a single user by ID
 * @route   GET /users/:id
 */
const getUserById = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.status(200).json(user);
    } catch (error) {
        logger.error('Error fetching user:', error);
        res.status(500).json({ message: 'Error fetching user', error });
    }
};

/**
 * @desc    Create a new user with optional profile picture
 * @route   POST /users
 */
const createUser = async (req, res) => {
    try {
        // Extract user data from the request body
        const userData = { ...req.body };
        const acceptance = buildPrivacyPolicyAcceptance(userData);

        if (acceptance.error) {
            return res.status(400).json(acceptance.error);
        }

        // Check if a file (profile picture) is uploaded
        if (req.file) {
            // Generate the URL for the uploaded profile picture
            const profilePicUrl = `${req.protocol}://${req.get('host')}/uploads/profilePics/${req.file.filename}`;
            userData.profilePic = profilePicUrl; // Save the URL in the user data
        }

        Object.assign(userData, acceptance);

        // Create a new user
        const user = new User(userData);
        await user.save();

        logger.info(`User created successfully: ${user.email}`);

        // Assign new user gift automatically
        try {
            const { checkAndAssignNewUserGift } = require('../../utils/giftAssignment');
            const giftResult = await checkAndAssignNewUserGift(user._id.toString());
            if (giftResult.assigned) {
                logger.info(`New user gift assigned to ${user.email}: ${giftResult.couponCode}`);
            }
        } catch (giftError) {
            logger.error(`Error assigning new user gift to ${user.email}:`, giftError);
            // Don't fail user creation if gift assignment fails
        }

        res.status(201).json(user);
    } catch (error) {
        logger.error('Error creating user:', error);
        res.status(400).json({ message: 'Error creating user', error });
    }
};

/**
 * @desc    Update a user by ID
 * @route   PUT /users/:id
 */
const updateUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check if a new profile picture is uploaded
        if (req.file) {
            // Generate the URL for the new profile picture
            const profilePicUrl = `${req.protocol}://${req.get('host')}/uploads/profilePics/${req.file.filename}`;

            // Delete the previous profile picture if it exists
            if (user.profilePic) {
                const previousPicPath = path.join(
                    'uploads/profilePics',
                    path.basename(user.profilePic)
                );
                fs.unlink(previousPicPath, (err) => {
                    if (err) {
                        logger.warn(`Failed to delete previous profile picture: ${previousPicPath}`);
                    } else {
                        logger.info(`Deleted previous profile picture: ${previousPicPath}`);
                    }
                });
            }

            // Update the profile picture URL in the request body
            req.body.profilePic = profilePicUrl;
        }

        // Update the user with the new data
        const updatedUser = await User.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        });

        res.status(200).json(updatedUser);
    } catch (error) {
        logger.error('Error updating user:', error);
        res.status(400).json({ message: 'Error updating user', error });
    }
};

/**
 * @desc    Delete a user by ID
 * @route   DELETE /users/:id
 */
const deleteUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Delete the profile picture if it exists
        if (user.profilePic) {
            const profilePicPath = path.join(
                'uploads/profilePics',
                path.basename(user.profilePic)
            );
            fs.unlink(profilePicPath, (err) => {
                if (err) {
                    logger.warn(`Failed to delete profile picture: ${profilePicPath}`);
                } else {
                    logger.info(`Deleted profile picture: ${profilePicPath}`);
                }
            });
        }

        // Delete the user
        await User.findByIdAndDelete(req.params.id);

        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        logger.error('Error deleting user:', error);
        res.status(500).json({ message: 'Error deleting user', error });
    }
};

/**
 * @desc    Validate JWT token
 * @route   GET /users/validate-token
 */
const validateToken = async (req, res) => {
    try {
        const authHeader = req.headers.authorization || req.headers.Authorization || '';
        
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                valid: false,
                message: 'No token provided'
            });
        }

        const token = authHeader.split(' ')[1];
        
        try {
            const decoded = jwt.verify(
                token,
                JWT_SECRET
            );
            
            const userId = decoded.id || decoded.userId;
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    valid: false,
                    message: 'Invalid token format'
                });
            }

            // Optionally verify user still exists
            const user = await User.findById(userId);
            if (!user) {
                return res.status(401).json({
                    success: false,
                    valid: false,
                    message: 'User not found'
                });
            }

            // Check if user is blocked
            if (user.isActive === false) {
                return res.status(403).json({
                    success: false,
                    valid: false,
                    message: 'User account is blocked'
                });
            }

            return res.status(200).json({
                success: true,
                valid: true,
                message: 'Token is valid',
                userId: user._id
            });
        } catch (jwtError) {
            logger.warn('Token validation failed:', jwtError.message);
            return res.status(401).json({
                success: false,
                valid: false,
                message: 'Invalid or expired token'
            });
        }
    } catch (error) {
        logger.error('Error validating token:', error);
        res.status(500).json({
            success: false,
            valid: false,
            message: 'Error validating token',
            error: error.message
        });
    }
};

/**
 * @desc    Get user by email
 * @route   GET /users/email/:email
 */
const getUserByEmail = async (req, res) => {
    try {
        const user = await User.findOne({ email: req.params.email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.status(200).json(user);
    } catch (error) {
        logger.error('Error fetching user by email:', error);
        res.status(500).json({ message: 'Error fetching user by email', error });
    }
};

/**
 * @desc    Login user by mobile number
 * @route   POST /users/login
 */
const loginUserByMobile = async (req, res) => {
    const { phoneNumber } = req.body;

    try {
        // Check if the phone number exists in the database
        const user = await User.findOne({ phoneNumber });

        if (user) {
            // Check if user is blocked
            if (user.isActive === false) {
                logger.warn(`Blocked user attempted login: ${user.phoneNumber}`);
                return res.status(403).json({
                    message: 'Your account has been blocked',
                    isBlocked: true,
                });
            }

            // Generate a JWT token
            if (!user.privacyPolicyAccepted) {
                const acceptance = buildPrivacyPolicyAcceptance(req.body);
                if (acceptance.error) {
                    return res.status(428).json({
                        ...acceptance.error,
                        code: 'PRIVACY_POLICY_ACCEPTANCE_REQUIRED',
                    });
                }
                Object.assign(user, acceptance);
                await user.save();
            }

            const token = jwt.sign(
                { id: user._id, phoneNumber: user.phoneNumber },
                JWT_SECRET,
                { expiresIn: '7d' } // Token expiration time
            );

            logger.info(`User logged in: ${user.phoneNumber}`);
            return res.status(200).json({
                message: 'Login successful',
                token,
                userId: user._id,
                phoneNumber: user.phoneNumber,
                isNewUser: false,
            });
        } else {
            // Auto-create user if not found
            try {
                logger.info(`Auto-creating new user with phone number: ${phoneNumber}`);
                const acceptance = buildPrivacyPolicyAcceptance(req.body);

                if (acceptance.error) {
                    return res.status(400).json(acceptance.error);
                }
                
                // Create new user with minimal data
                // Using placeholder values for required fields that will be updated in profile-details
                const newUser = new User({
                    phoneNumber: phoneNumber,
                    fullName: 'Pending', // Placeholder - will be updated in profile-details
                    email: `temp_${phoneNumber}@cerca.temp`, // Temporary email, will be updated
                    isActive: true,
                    lastLogin: new Date(),
                    isVerified: false,
                    ...acceptance,
                });

                await newUser.save();
                logger.info(`New user created successfully: ${newUser._id}`);

                // Generate JWT token for the newly created user
                const token = jwt.sign(
                    { id: newUser._id, phoneNumber: newUser.phoneNumber },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );

                logger.info(`New user logged in: ${newUser.phoneNumber}`);
                return res.status(200).json({
                    message: 'Login successful',
                    token,
                    userId: newUser._id,
                    phoneNumber: newUser.phoneNumber,
                    isNewUser: true, // true for newly created users
                });
            } catch (createError) {
                logger.error('Error auto-creating user:', createError);
                // If user creation fails (e.g., duplicate phone number), return error
                return res.status(500).json({
                    message: 'An error occurred during user creation',
                    error: createError.message,
                });
            }
        }
    } catch (error) {
        logger.error('Error during login:', error);
        return res.status(500).json({
            message: 'An error occurred during login',
            error: error.message,
        });
    }
};

// Add wallet-related controller functions

/**
 * @desc    Get the wallet balance of a user by ID
 * @route   GET /users/:id/wallet
 */
const getUserWallet = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.status(200).json({ walletBalance: user.walletBalance });
    } catch (error) {
        logger.error('Error fetching wallet balance:', error);
        res.status(500).json({ message: 'Error fetching wallet balance', error });
    }
};

/**
 * @desc    Update the wallet balance of a user by ID and type add or deduct
 * @route   PUT /users/:id/wallet
 */
const updateUserWallet = async (req, res) => {
    try {
        const { amount, type } = req.body; // type = 'add' or 'deduct'

        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ message: 'Invalid wallet amount' });
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (type === 'deduct') {
            if (user.walletBalance < amount) {
                return res.status(400).json({ message: 'Insufficient wallet balance' });
            }
            user.walletBalance -= amount;
        } else if (type === 'add') {
            user.walletBalance += amount;
        } else {
            return res.status(400).json({ message: 'Invalid transaction type' });
        }

        await user.save();

        res.status(200).json({
            message: `Wallet ${type === 'add' ? 'credited' : 'debited'} successfully`,
            walletBalance: user.walletBalance,
        });
    } catch (error) {
        logger.error('Error updating wallet balance:', error);
        res.status(500).json({ message: 'Error updating wallet balance', error });
    }
};


module.exports = {
  getPrivacyPolicy,
  acceptPrivacyPolicy,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserByEmail,
  loginUserByMobile,
  getUserWallet,
  updateUserWallet,
  validateToken,
};
