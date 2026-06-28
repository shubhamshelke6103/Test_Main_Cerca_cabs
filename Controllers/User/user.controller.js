const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')

const User = require('../../Models/User/user.model')
const logger = require('../../utils/logger')
const {
  getPendingDriverInProgressCancelSettlements
} = require('../../utils/ride_booking_functions.js')
const {
  normalizeEmail,
  normalizeMobileDigits
} = require('../../utils/contactValidation')
const AppError = require('../../utils/errors/AppError')
const asyncHandler = require('../../utils/errors/asyncHandler')

const PRIVACY_POLICY_VERSION =
  process.env.PRIVACY_POLICY_VERSION || '2026-03-23'
const PRIVACY_POLICY_URL = process.env.PRIVACY_POLICY_URL || '/privacy-policy'
const JWT_SECRET =
  process.env.JWT_SECRET ||
  '@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%'

const parseBoolean = value => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return false
}

const getPrivacyPolicyMetadata = () => ({
  version: PRIVACY_POLICY_VERSION,
  url: PRIVACY_POLICY_URL
})

const extractFcmToken = (payload = {}) => {
  const token = payload.fcmToken
  if (typeof token !== 'string') {
    return null
  }
  const normalized = token.trim()
  return normalized.length > 0 ? normalized : null
}

const buildPrivacyPolicyAcceptance = (payload = {}) => {
  const accepted = parseBoolean(payload.privacyPolicyAccepted)

  if (!accepted) {
    return {
      error: {
        message: 'Privacy policy acceptance is required during registration',
        privacyPolicy: getPrivacyPolicyMetadata()
      }
    }
  }

  return {
    privacyPolicyAccepted: true,
    privacyPolicyAcceptedAt: new Date(),
    privacyPolicyVersion:
      payload.privacyPolicyVersion || PRIVACY_POLICY_VERSION,
    privacyPolicyUrl: payload.privacyPolicyUrl || PRIVACY_POLICY_URL
  }
}

const getAuthUserIdOrThrow = req => {
  const authHeader =
    req.headers.authorization || req.headers.Authorization || ''
  if (!authHeader.startsWith('Bearer ')) {
    throw new AppError('Authentication required', 401, {
      code: 'AUTHENTICATION_REQUIRED'
    })
  }

  const token = authHeader.split(' ')[1]
  const decoded = jwt.verify(token, JWT_SECRET)
  return decoded.id || decoded.userId
}

const getPrivacyPolicy = asyncHandler(async (req, res) => {
  return res.status(200).json({
    success: true,
    privacyPolicy: getPrivacyPolicyMetadata()
  })
})

const acceptPrivacyPolicy = asyncHandler(async (req, res) => {
  const userId = getAuthUserIdOrThrow(req)
  const user = await User.findById(userId)

  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  const acceptance = buildPrivacyPolicyAcceptance(req.body)
  if (acceptance.error) {
    throw new AppError(acceptance.error.message, 400, {
      code: 'PRIVACY_POLICY_ACCEPTANCE_REQUIRED',
      details: {
        privacyPolicy: acceptance.error.privacyPolicy
      }
    })
  }

  Object.assign(user, acceptance)
  await user.save()

  return res.status(200).json({
    success: true,
    message: 'Privacy policy accepted successfully',
    privacyPolicy: getPrivacyPolicyMetadata()
  })
})

const getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  res.status(200).json(user)
})

const createUser = asyncHandler(async (req, res) => {
  const userData = { ...req.body }
  const normalizedEmail = normalizeEmail(userData.email)
  if (normalizedEmail.error) {
    throw new AppError(normalizedEmail.error, 400, {
      code: 'INVALID_EMAIL'
    })
  }
  userData.email = normalizedEmail.value

  if (userData.phoneNumber !== undefined) {
    const normalizedPhone = normalizeMobileDigits(userData.phoneNumber)
    if (normalizedPhone.error) {
      throw new AppError(normalizedPhone.error, 400, {
        code: 'INVALID_PHONE_NUMBER'
      })
    }
    userData.phoneNumber = normalizedPhone.value
  }

  const acceptance = buildPrivacyPolicyAcceptance(userData)
  if (acceptance.error) {
    throw new AppError(acceptance.error.message, 400, {
      code: 'PRIVACY_POLICY_ACCEPTANCE_REQUIRED',
      details: {
        privacyPolicy: acceptance.error.privacyPolicy
      }
    })
  }

  if (req.file) {
    const profilePicUrl = `${req.protocol}://${req.get(
      'host'
    )}/uploads/profilePics/${req.file.filename}`
    userData.profilePic = profilePicUrl
  }

  const fcmToken = extractFcmToken(userData)
  if (fcmToken) {
    userData.fcmToken = fcmToken
    userData.fcmTokenUpdatedAt = new Date()
  }

  Object.assign(userData, acceptance)

  const user = new User(userData)
  await user.save()

  logger.info(`User created successfully: ${user.email}`)

  try {
    const { checkAndAssignNewUserGift } = require('../../utils/giftAssignment')
    const giftResult = await checkAndAssignNewUserGift(user._id.toString())
    if (giftResult.assigned) {
      logger.info(
        `New user gift assigned to ${user.email}: ${giftResult.couponCode}`
      )
    }
  } catch (giftError) {
    logger.error(`Error assigning new user gift to ${user.email}:`, giftError)
  }

  res.status(201).json(user)
})

const updateUser = asyncHandler(async (req, res) => {
  const payload = { ...req.body }
  if (payload.email !== undefined) {
    const normalizedEmail = normalizeEmail(payload.email)
    if (normalizedEmail.error) {
      throw new AppError(normalizedEmail.error, 400, {
        code: 'INVALID_EMAIL'
      })
    }
    payload.email = normalizedEmail.value
  }

  if (payload.phoneNumber !== undefined) {
    const normalizedPhone = normalizeMobileDigits(payload.phoneNumber)
    if (normalizedPhone.error) {
      throw new AppError(normalizedPhone.error, 400, {
        code: 'INVALID_PHONE_NUMBER'
      })
    }
    payload.phoneNumber = normalizedPhone.value
  }

  const fcmToken = extractFcmToken(payload)
  if (fcmToken) {
    payload.fcmToken = fcmToken
    payload.fcmTokenUpdatedAt = new Date()
  }

  const user = await User.findById(req.params.id)
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  if (req.file) {
    const profilePicUrl = `${req.protocol}://${req.get(
      'host'
    )}/uploads/profilePics/${req.file.filename}`

    if (user.profilePic) {
      const previousPicPath = path.join(
        'uploads/profilePics',
        path.basename(user.profilePic)
      )
      fs.unlink(previousPicPath, err => {
        if (err) {
          logger.warn(
            `Failed to delete previous profile picture: ${previousPicPath}`
          )
        } else {
          logger.info(`Deleted previous profile picture: ${previousPicPath}`)
        }
      })
    }

    payload.profilePic = profilePicUrl
  }

  const updatedUser = await User.findByIdAndUpdate(req.params.id, payload, {
    new: true,
    runValidators: true
  })

  res.status(200).json(updatedUser)
})

const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  if (user.profilePic) {
    const profilePicPath = path.join(
      'uploads/profilePics',
      path.basename(user.profilePic)
    )
    fs.unlink(profilePicPath, err => {
      if (err) {
        logger.warn(`Failed to delete profile picture: ${profilePicPath}`)
      } else {
        logger.info(`Deleted profile picture: ${profilePicPath}`)
      }
    })
  }

  await User.findByIdAndDelete(req.params.id)

  res.status(200).json({ message: 'User deleted successfully' })
})

const deleteAuthenticatedUser = asyncHandler(async (req, res) => {
  const userId = getAuthUserIdOrThrow(req)
  const user = await User.findById(userId)
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  if (user.profilePic) {
    const profilePicPath = path.join(
      'uploads/profilePics',
      path.basename(user.profilePic)
    )
    fs.unlink(profilePicPath, err => {
      if (err) {
        logger.warn(`Failed to delete profile picture: ${profilePicPath}`)
      } else {
        logger.info(`Deleted profile picture: ${profilePicPath}`)
      }
    })
  }

  await User.findByIdAndDelete(userId)

  res.status(200).json({
    success: true,
    message: 'User deleted successfully'
  })
})

const deleteAccountByIdentifier = asyncHandler(async (req, res) => {
  const { identifier } = req.body

  if (!identifier) {
    throw new AppError('Email or Mobile Number is required', 400)
  }

  const user = await User.findOne({
    $or: [{ email: identifier }, { mobile: identifier }]
  })

  if (!user) {
    throw new AppError('User not found', 404)
  }

  if (user.profilePic) {
    const profilePicPath = path.join(
      'uploads/profilePics',
      path.basename(user.profilePic)
    )

    fs.unlink(profilePicPath, () => {})
  }

  await User.findByIdAndDelete(user._id)

  res.json({
    success: true,
    message: 'Your account has been deleted successfully.'
  })
})

const validateToken = asyncHandler(async (req, res) => {
  const authHeader =
    req.headers.authorization || req.headers.Authorization || ''

  if (!authHeader.startsWith('Bearer ')) {
    throw new AppError('No token provided', 401, {
      code: 'TOKEN_MISSING',
      details: { valid: false }
    })
  }

  const token = authHeader.split(' ')[1]
  const decoded = jwt.verify(token, JWT_SECRET)
  const userId = decoded.id || decoded.userId

  if (!userId) {
    throw new AppError('Invalid token format', 401, {
      code: 'INVALID_TOKEN_FORMAT',
      details: { valid: false }
    })
  }

  const user = await User.findById(userId)
  if (!user) {
    throw new AppError('User not found', 401, {
      code: 'TOKEN_USER_NOT_FOUND',
      details: { valid: false }
    })
  }

  if (user.isActive === false) {
    throw new AppError('User account is blocked', 403, {
      code: 'USER_BLOCKED',
      details: { valid: false, isBlocked: true }
    })
  }

  return res.status(200).json({
    success: true,
    valid: true,
    message: 'Token is valid',
    userId: user._id
  })
})

const getUserByEmail = asyncHandler(async (req, res) => {
  const normalizedEmail = normalizeEmail(req.params.email)
  if (normalizedEmail.error) {
    throw new AppError(normalizedEmail.error, 400, {
      code: 'INVALID_EMAIL'
    })
  }

  const user = await User.findOne({ email: normalizedEmail.value })
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  res.status(200).json(user)
})

const loginUserByMobile = asyncHandler(async (req, res) => {
  const normalizedPhone = normalizeMobileDigits(req.body.phoneNumber)
  if (normalizedPhone.error || !normalizedPhone.value) {
    throw new AppError(
      normalizedPhone.error || 'Phone number is required',
      400,
      {
        code: 'INVALID_PHONE_NUMBER'
      }
    )
  }
  const phoneNumber = normalizedPhone.value

  const user = await User.findOne({ phoneNumber })

  if (user) {
    if (user.isActive === false) {
      logger.warn(`Blocked user attempted login: ${user.phoneNumber}`)
      throw new AppError('Your account has been blocked', 403, {
        code: 'USER_BLOCKED',
        details: { isBlocked: true }
      })
    }

    if (!user.privacyPolicyAccepted) {
      const acceptance = buildPrivacyPolicyAcceptance(req.body)
      if (acceptance.error) {
        throw new AppError(acceptance.error.message, 428, {
          code: 'PRIVACY_POLICY_ACCEPTANCE_REQUIRED',
          details: {
            privacyPolicy: acceptance.error.privacyPolicy
          }
        })
      }
      Object.assign(user, acceptance)
      await user.save()
    }

    const fcmToken = extractFcmToken(req.body)
    if (fcmToken) {
      user.fcmToken = fcmToken
      user.fcmTokenUpdatedAt = new Date()
      await user.save()
    }

    const token = jwt.sign(
      { id: user._id, phoneNumber: user.phoneNumber },
      JWT_SECRET,
      { expiresIn: '7d' }
    )

    logger.info(`User logged in: ${user.phoneNumber}`)
    return res.status(200).json({
      message: 'Login successful',
      token,
      userId: user._id,
      phoneNumber: user.phoneNumber,
      isNewUser: false
    })
  }

  logger.info(`Auto-creating new user with phone number: ${phoneNumber}`)
  const acceptance = buildPrivacyPolicyAcceptance(req.body)
  if (acceptance.error) {
    throw new AppError(acceptance.error.message, 400, {
      code: 'PRIVACY_POLICY_ACCEPTANCE_REQUIRED',
      details: {
        privacyPolicy: acceptance.error.privacyPolicy
      }
    })
  }

  const newUser = new User({
    phoneNumber,
    fullName: 'Pending',
    email: `temp_${phoneNumber}@cerca.temp`,
    isActive: true,
    lastLogin: new Date(),
    isVerified: false,
    fcmToken: extractFcmToken(req.body),
    fcmTokenUpdatedAt: extractFcmToken(req.body) ? new Date() : null,
    ...acceptance
  })

  await newUser.save()
  logger.info(`New user created successfully: ${newUser._id}`)

  const token = jwt.sign(
    { id: newUser._id, phoneNumber: newUser.phoneNumber },
    JWT_SECRET,
    { expiresIn: '7d' }
  )

  logger.info(`New user logged in: ${newUser.phoneNumber}`)
  return res.status(200).json({
    message: 'Login successful',
    token,
    userId: newUser._id,
    phoneNumber: newUser.phoneNumber,
    isNewUser: true
  })
})

const getOutstandingDriverCancelSettlements = asyncHandler(async (req, res) => {
  const authUserId = getAuthUserIdOrThrow(req)
  if (String(authUserId) !== String(req.params.id)) {
    throw new AppError('Forbidden', 403, {
      code: 'FORBIDDEN'
    })
  }

  const { items, totalAdditionalDue } =
    await getPendingDriverInProgressCancelSettlements(req.params.id)

  return res.status(200).json({
    success: true,
    data: { items, totalAdditionalDue }
  })
})

const getUserWallet = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  res.status(200).json({ walletBalance: user.walletBalance })
})

const updateUserWallet = asyncHandler(async (req, res) => {
  const { amount, type } = req.body

  if (typeof amount !== 'number' || amount <= 0) {
    throw new AppError('Invalid wallet amount', 400, {
      code: 'INVALID_WALLET_AMOUNT'
    })
  }

  const user = await User.findById(req.params.id)
  if (!user) {
    throw new AppError('User not found', 404, {
      code: 'USER_NOT_FOUND'
    })
  }

  if (type === 'deduct') {
    if (user.walletBalance < amount) {
      throw new AppError('Insufficient wallet balance', 400, {
        code: 'INSUFFICIENT_WALLET_BALANCE'
      })
    }
    user.walletBalance -= amount
  } else if (type === 'add') {
    user.walletBalance += amount
  } else {
    throw new AppError('Invalid transaction type', 400, {
      code: 'INVALID_TRANSACTION_TYPE'
    })
  }

  await user.save()

  res.status(200).json({
    message: `Wallet ${type === 'add' ? 'credited' : 'debited'} successfully`,
    walletBalance: user.walletBalance
  })
})

/**
 * @desc    Update the rider's FCM device token (called by the rider app
 *          after `PushNotifications.register` resolves the token).
 * @route   PATCH /users/:id/fcm-token
 * @access  Authenticated user (must match :id)
 */
const updateUserFcmToken = asyncHandler(async (req, res) => {
  const authUserId = getAuthUserIdOrThrow(req)
  if (String(authUserId) !== String(req.params.id)) {
    throw new AppError('Forbidden', 403, { code: 'FORBIDDEN' })
  }

  const { fcmToken: rawToken, platform } = req.body || {}

  // Allow explicit clear via fcmToken: null (logout / token revoke).
  if (rawToken === null) {
    await User.findByIdAndUpdate(req.params.id, {
      $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() }
    })
    logger.info('FCM token update', {
      userId: req.params.id,
      platform: platform || 'unknown',
      action: 'cleared'
    })
    return res.status(200).json({ success: true, cleared: true })
  }

  const token = extractFcmToken(req.body)
  if (!token) {
    throw new AppError('fcmToken is required', 400, {
      code: 'INVALID_FCM_TOKEN'
    })
  }

  await User.findByIdAndUpdate(req.params.id, {
    $set: { fcmToken: token, fcmTokenUpdatedAt: new Date() }
  })
  logger.info('FCM token update', {
    userId: req.params.id,
    platform: platform || 'unknown',
    action: 'success',
    tokenLength: token.length
  })
  res.status(200).json({ success: true })
})

module.exports = {
  getPrivacyPolicy,
  acceptPrivacyPolicy,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  deleteAuthenticatedUser,
  deleteAccountByIdentifier,
  getUserByEmail,
  loginUserByMobile,
  getUserWallet,
  updateUserWallet,
  validateToken,
  getOutstandingDriverCancelSettlements,
  updateUserFcmToken
}
