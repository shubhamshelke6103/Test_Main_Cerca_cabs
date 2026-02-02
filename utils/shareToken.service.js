const crypto = require('crypto');
const logger = require('./logger');

/**
 * Generate a cryptographically secure share token
 * @returns {string} URL-safe base64 encoded token (32 bytes = 43 characters)
 */
function generateShareToken() {
  // Generate 32 random bytes
  const randomBytes = crypto.randomBytes(32);
  // Convert to URL-safe base64 (replaces + with -, / with _, removes = padding)
  const token = randomBytes.toString('base64url');
  return token;
}

/**
 * Validate share token format
 * @param {string} token - Token to validate
 * @returns {boolean} True if token format is valid
 */
function isValidTokenFormat(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  // Check if token is base64url format (alphanumeric, -, _)
  // Length should be around 43 characters for 32 bytes
  const base64urlRegex = /^[A-Za-z0-9_-]{32,}$/;
  return base64urlRegex.test(token);
}

/**
 * Check if share token is expired
 * @param {Date} expiresAt - Expiration date
 * @returns {boolean} True if token is expired
 */
function isTokenExpired(expiresAt) {
  if (!expiresAt) {
    return true; // No expiration date means expired
  }
  return new Date() > new Date(expiresAt);
}

/**
 * Generate share token and set expiration
 * Expiration is set to when ride completes (or 24 hours from now as fallback)
 * @param {Object} ride - Ride document
 * @returns {Object} Object with token and expiration date
 */
function generateTokenForRide(ride) {
  const token = generateShareToken();
  
  // Set expiration to ride completion time if ride is active
  // Otherwise, set to 24 hours from now as fallback
  let expiresAt;
  
  if (ride.status === 'completed' || ride.status === 'cancelled') {
    // If ride is already completed/cancelled, expire immediately
    expiresAt = new Date();
  } else {
    // Set expiration to 24 hours from now (or when ride completes, whichever comes first)
    // The actual expiration will be checked when ride completes
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  }
  
  return {
    token,
    expiresAt
  };
}

/**
 * Validate share token and check expiration
 * @param {string} token - Token to validate
 * @param {Date} expiresAt - Expiration date from database
 * @returns {Object} Validation result with isValid and reason
 */
function validateShareToken(token, expiresAt) {
  if (!isValidTokenFormat(token)) {
    return {
      isValid: false,
      reason: 'INVALID_FORMAT',
      message: 'Invalid token format'
    };
  }
  
  if (isTokenExpired(expiresAt)) {
    return {
      isValid: false,
      reason: 'EXPIRED',
      message: 'Share link has expired'
    };
  }
  
  return {
    isValid: true,
    reason: null,
    message: 'Token is valid'
  };
}

module.exports = {
  generateShareToken,
  isValidTokenFormat,
  isTokenExpired,
  generateTokenForRide,
  validateShareToken
};

