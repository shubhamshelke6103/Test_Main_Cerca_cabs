const crypto = require('crypto')
const LiveLocationShare = require('../Models/Shared/liveLocationShare.model')
const Driver = require('../Models/Driver/driver.model')
const Ride = require('../Models/Driver/ride.model')

const generateShareToken = () => crypto.randomBytes(24).toString('base64url')
const MIN_SHARE_DURATION_MINUTES = 5
const MAX_SHARE_DURATION_MINUTES = 24 * 60
const ACTIVE_RIDE_STATUSES = new Set(['requested', 'accepted', 'arrived', 'in_progress', 'ongoing'])

const createLiveLocationShare = async ({
  ownerId,
  ownerModel,
  rideId = null,
  recipientName,
  recipientPhone = null,
  recipientEmail = null,
  recipientType = 'trusted_contact',
  relation = null,
  durationMinutes = 120
}) => {
  const safeDurationMinutes = Math.max(
    MIN_SHARE_DURATION_MINUTES,
    Math.min(MAX_SHARE_DURATION_MINUTES, Number(durationMinutes) || 120)
  )
  const expiresAt = new Date(Date.now() + safeDurationMinutes * 60 * 1000)

  return LiveLocationShare.create({
    owner: ownerId,
    ownerModel,
    ride: rideId,
    shareToken: generateShareToken(),
    recipientName,
    recipientPhone,
    recipientEmail,
    recipientType,
    relation,
    expiresAt,
    isActive: true
  })
}

const revokeLiveLocationShare = async (shareId, ownerId) =>
  LiveLocationShare.findOneAndUpdate(
    { _id: shareId, owner: ownerId },
    { $set: { isActive: false, expiresAt: new Date() } },
    { new: true }
  )

const maskPhone = value => {
  if (!value) return null
  const digits = String(value)
  if (digits.length <= 4) return digits
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

const getSharedLiveLocationPayload = async shareToken => {
  const share = await LiveLocationShare.findOne({
    shareToken,
    isActive: true
  }).lean()

  if (!share) {
    throw new Error('Shared live location not found')
  }

  if (new Date() > new Date(share.expiresAt)) {
    await LiveLocationShare.updateOne(
      { _id: share._id },
      { $set: { isActive: false } }
    )
    throw new Error('Shared live location has expired')
  }

  let payload
  if (share.ownerModel === 'Driver') {
    const driver = await Driver.findById(share.owner)
      .select('name location isOnline vehicleInfo vendorId')
      .lean()
    if (!driver) {
      throw new Error('Driver not found for shared location')
    }

    payload = {
      ownerModel: 'Driver',
      driver: {
        id: driver._id,
        name: driver.name,
        isOnline: driver.isOnline,
        location: driver.location || null,
        vehicleInfo: driver.vehicleInfo || null
      }
    }
  } else {
    const ride = await Ride.findById(share.ride)
      .populate('driver', 'name location vehicleInfo')
      .select(
        'status pickupAddress dropoffAddress pickupLocation dropoffLocation actualStartTime actualEndTime'
      )
      .lean()

    if (!ride) {
      throw new Error('Ride not found for shared location')
    }
    if (!ACTIVE_RIDE_STATUSES.has(ride.status)) {
      await LiveLocationShare.updateOne(
        { _id: share._id },
        { $set: { isActive: false, expiresAt: new Date() } }
      )
      throw new Error('Ride is no longer active for shared live location')
    }

    payload = {
      ownerModel: 'User',
      ride: {
        id: ride._id,
        status: ride.status,
        pickupAddress: ride.pickupAddress,
        dropoffAddress: ride.dropoffAddress,
        pickupLocation: ride.pickupLocation,
        dropoffLocation: ride.dropoffLocation,
        actualStartTime: ride.actualStartTime,
        actualEndTime: ride.actualEndTime
      },
      driver: ride.driver
        ? {
            name: ride.driver.name,
            location: ride.driver.location || null,
            vehicleInfo: ride.driver.vehicleInfo || null
          }
        : null
    }
  }

  await LiveLocationShare.updateOne(
    { _id: share._id },
    {
      $inc: { accessCount: 1 },
      $set: { lastAccessedAt: new Date() }
    }
  )

  return {
    share: {
      id: share._id,
      recipientName: share.recipientName,
      recipientType: share.recipientType,
      relation: share.relation,
      recipientPhone: maskPhone(share.recipientPhone),
      expiresAt: share.expiresAt
    },
    ...payload
  }
}

module.exports = {
  createLiveLocationShare,
  revokeLiveLocationShare,
  getSharedLiveLocationPayload
}
