const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const { TERMINAL_STATUSES } = require('../../Models/Admin/paymentDispute.model')
const Ride = require('../../Models/Driver/ride.model')
const User = require('../../Models/User/user.model')
const Driver = require('../../Models/Driver/driver.model')
const InternalSettlement = require('../../Models/Admin/internalSettlement.model')
const { syncAdminEarningsAfterRidePaid } = require('../adminEarningsSettlement')
const { getPaymentDisputePolicy } = require('./policy')
const { roundInr, recalcRiderPendingDues } = require('./dues.service')
const { notifyPaymentDispute } = require('./disputeNotifications.service')
const logger = require('../logger')

const REVIEW_ISSUE_TYPES = new Set([
  'FAKE_UPI_SCREENSHOT',
  'PAYMENT_NOT_CONFIRMED',
  'RIDER_PAYMENT_PROOF',
])

const appendAudit = (dispute, { fromStatus, toStatus, action, actorId, actorRole, note }) => {
  dispute.auditLog.push({
    fromStatus: fromStatus || dispute.status,
    toStatus,
    action,
    actorId: actorId || null,
    actorRole: actorRole || 'system',
    note: note || null,
    at: new Date(),
  })
}

const getActiveDisputeForRide = async (rideId) => {
  return PaymentDispute.findOne({
    rideId,
    status: { $nin: TERMINAL_STATUSES },
  })
}

const assertDriverCanReport = async (ride, driverId) => {
  if (!ride || ride.status !== 'completed') {
    throw new Error('Ride must be completed before reporting a payment issue')
  }
  if (ride.driver?.toString() !== driverId && ride.driver?._id?.toString() !== driverId) {
    throw new Error('Ride does not belong to this driver')
  }
  const policy = await getPaymentDisputePolicy()
  const completedAt = ride.actualEndTime || ride.updatedAt
  if (completedAt) {
    const graceMs = (policy.disputeReportGraceMinutes || 0) * 60 * 1000
    const minReportAt = new Date(completedAt.getTime() + graceMs)
    if (new Date() < minReportAt && policy.disputeReportGraceMinutes > 0) {
      throw new Error(
        `Please wait ${policy.disputeReportGraceMinutes} minutes after ride completion before reporting`
      )
    }
  }
  const existing = await getActiveDisputeForRide(ride._id)
  if (existing) {
    throw new Error('An active payment dispute already exists for this ride')
  }
}

const createDriverDispute = async ({
  rideId,
  driverId,
  issueType,
  driverNote,
  amountReceived,
  evidence = [],
}) => {
  const ride = await Ride.findById(rideId).populate('rider driver')
  await assertDriverCanReport(ride, driverId)

  const fare = roundInr(ride.fare || 0)
  let received = 0
  let remaining = fare
  let initialStatus = 'AWAITING_RIDER_PAYMENT'

  if (issueType === 'PARTIAL_PAYMENT') {
    received = roundInr(amountReceived)
    if (received < 0 || received >= fare) {
      throw new Error('Partial payment: amount received must be greater than 0 and less than fare')
    }
    remaining = roundInr(fare - received)
  } else if (issueType === 'FAKE_UPI_SCREENSHOT' || issueType === 'PAYMENT_NOT_CONFIRMED') {
    remaining = fare
    received = 0
    initialStatus = 'UNDER_REVIEW'
  } else {
    remaining = fare
    received = 0
  }

  const dispute = new PaymentDispute({
    rideId: ride._id,
    riderId: ride.rider._id || ride.rider,
    driverId: ride.driver._id || ride.driver,
    issueType,
    status: initialStatus,
    paymentContext: {
      fare,
      paymentMethod: ride.paymentMethod || 'CASH',
      amountDue: fare,
      amountReceived: received,
      amountRemaining: remaining,
    },
    driverNote: driverNote || null,
    evidence: evidence.map((e) => ({
      ...e,
      uploadedBy: driverId,
      role: 'driver',
    })),
  })

  appendAudit(dispute, {
    fromStatus: null,
    toStatus: initialStatus,
    action: 'DRIVER_REPORT',
    actorId: driverId,
    actorRole: 'driver',
  })

  await dispute.save()

  let ridePaymentStatus = ride.paymentStatus || 'pending'
  if (issueType === 'PARTIAL_PAYMENT') {
    ridePaymentStatus = 'partial'
  } else if (ridePaymentStatus === 'completed') {
    ridePaymentStatus = 'pending'
  }

  await Ride.findByIdAndUpdate(rideId, {
    paymentStatus: ridePaymentStatus,
    'paymentCollection.status': 'disputed',
    'paymentCollection.amountDue': fare,
    'paymentCollection.amountReceived': received,
    'paymentCollection.amountRemaining': remaining,
    'paymentCollection.activeDisputeId': dispute._id,
    'paymentCollection.autoConfirmAt': null,
  })

  await recalcRiderPendingDues(dispute.riderId)

  await notifyPaymentDispute({
    recipientId: dispute.riderId,
    recipientModel: 'User',
    templateKey:
      initialStatus === 'UNDER_REVIEW'
        ? 'DISPUTE_UNDER_REVIEW'
        : 'PENDING_PAYMENT_DETECTED',
    rideId: ride._id,
    disputeId: dispute._id,
  })

  if (initialStatus === 'AWAITING_RIDER_PAYMENT') {
    await notifyPaymentDispute({
      recipientId: dispute.riderId,
      recipientModel: 'User',
      templateKey: 'BOOKING_BLOCKED_DUES',
      rideId: ride._id,
      disputeId: dispute._id,
    })
  }

  return dispute
}

const addEvidence = async ({ disputeId, uploadedBy, role, url, mimeType, note, issueType }) => {
  const dispute = await PaymentDispute.findById(disputeId)
  if (!dispute || TERMINAL_STATUSES.includes(dispute.status)) {
    throw new Error('Dispute not found or already closed')
  }

  if (role === 'rider' && String(dispute.riderId) !== String(uploadedBy)) {
    throw new Error('Not authorized')
  }
  if (role === 'driver' && String(dispute.driverId) !== String(uploadedBy)) {
    throw new Error('Not authorized')
  }

  dispute.evidence.push({
    uploadedBy,
    role,
    url,
    mimeType,
    note,
    issueType: issueType || null,
  })

  if (role === 'rider' && issueType === 'RIDER_PAYMENT_PROOF') {
    const prev = dispute.status
    if (dispute.status === 'AWAITING_RIDER_PAYMENT' || dispute.status === 'OPEN') {
      dispute.status = 'UNDER_REVIEW'
      appendAudit(dispute, {
        fromStatus: prev,
        toStatus: 'UNDER_REVIEW',
        action: 'RIDER_PROOF',
        actorId: uploadedBy,
        actorRole: 'rider',
      })
    }
    await notifyPaymentDispute({
      recipientId: dispute.driverId,
      recipientModel: 'Driver',
      templateKey: 'DISPUTE_UNDER_REVIEW',
      rideId: dispute.rideId,
      disputeId: dispute._id,
    })
  }

  await dispute.save()
  return dispute
}

const driverConfirmPaymentReceived = async ({ disputeId, driverId }) => {
  const dispute = await PaymentDispute.findById(disputeId)
  if (!dispute) throw new Error('Dispute not found')
  if (String(dispute.driverId) !== String(driverId)) {
    throw new Error('Not authorized')
  }
  if (TERMINAL_STATUSES.includes(dispute.status)) {
    throw new Error('Dispute already closed')
  }
  if (dispute.status === 'UNDER_REVIEW') {
    throw new Error('Cannot confirm while dispute is under admin review')
  }

  return resolveDisputePaid({
    dispute,
    resolvedBy: driverId,
    actorRole: 'driver',
    outcome: 'DRIVER_CONFIRMED_OFFLINE',
  })
}

const resolveDisputePaid = async ({
  dispute,
  resolvedBy,
  actorRole = 'system',
  outcome = 'PAID',
  recoveryPaymentId = null,
}) => {
  const prev = dispute.status
  dispute.status = 'RESOLVED_PAID'
  dispute.resolution = {
    outcome,
    resolvedBy,
    resolvedAt: new Date(),
    adminNote: dispute.resolution?.adminNote || null,
  }
  if (recoveryPaymentId) {
    dispute.recoveryPaymentId = recoveryPaymentId
  }
  appendAudit(dispute, {
    fromStatus: prev,
    toStatus: 'RESOLVED_PAID',
    action: 'RESOLVED_PAID',
    actorId: resolvedBy,
    actorRole,
  })
  await dispute.save()

  const fare = roundInr(dispute.paymentContext?.fare || 0)
  await Ride.findByIdAndUpdate(dispute.rideId, {
    paymentStatus: 'completed',
    'paymentCollection.status': 'paid',
    'paymentCollection.amountReceived': fare,
    'paymentCollection.amountRemaining': 0,
    'paymentCollection.collectedAt': new Date(),
    'paymentCollection.activeDisputeId': null,
    'paymentCollection.autoConfirmAt': null,
  })

  try {
    await syncAdminEarningsAfterRidePaid(dispute.rideId)
  } catch (err) {
    logger.warn(`syncAdminEarningsAfterRidePaid failed for ${dispute.rideId}: ${err.message}`)
  }

  await recalcRiderPendingDues(dispute.riderId)

  await notifyPaymentDispute({
    recipientId: dispute.driverId,
    recipientModel: 'Driver',
    templateKey: 'PAYMENT_RECEIVED_SUCCESS',
    rideId: dispute.rideId,
    disputeId: dispute._id,
  })

  return dispute
}

const adminResolveDispute = async ({
  disputeId,
  adminId,
  action,
  adminNote,
  compensationAmount,
}) => {
  const dispute = await PaymentDispute.findById(disputeId)
  if (!dispute) throw new Error('Dispute not found')
  if (TERMINAL_STATUSES.includes(dispute.status)) {
    throw new Error('Dispute already closed')
  }

  const policy = await getPaymentDisputePolicy()
  const prev = dispute.status

  switch (action) {
    case 'CONFIRM_FRAUD': {
      dispute.status = 'AWAITING_RIDER_PAYMENT'
      dispute.fraudFlags.riderFraudIncrement = 1
      dispute.resolution = {
        ...dispute.resolution,
        adminNote,
      }
      appendAudit(dispute, {
        fromStatus: prev,
        toStatus: dispute.status,
        action: 'CONFIRM_FRAUD',
        actorId: adminId,
        actorRole: 'admin',
        note: adminNote,
      })
      await dispute.save()

      const rider = await User.findById(dispute.riderId)
      if (rider) {
        rider.paymentCompliance = rider.paymentCompliance || {}
        rider.paymentCompliance.fraudScore =
          (rider.paymentCompliance.fraudScore || 0) + 1
        rider.paymentCompliance.lastDisputeAt = new Date()
        if (
          rider.paymentCompliance.fraudScore >= policy.riderFraudSuspendThreshold
        ) {
          rider.isActive = false
        }
        await rider.save()
      }

      await recalcRiderPendingDues(dispute.riderId)
      await notifyPaymentDispute({
        recipientId: dispute.riderId,
        recipientModel: 'User',
        templateKey: 'PENDING_PAYMENT_DETECTED',
        rideId: dispute.rideId,
        disputeId: dispute._id,
      })
      break
    }

    case 'REJECT_DRIVER_COMPLAINT': {
      dispute.status = 'RESOLVED_REJECTED'
      dispute.fraudFlags.driverFraudIncrement = 1
      dispute.resolution = {
        outcome: 'DRIVER_FALSE_COMPLAINT',
        resolvedBy: adminId,
        resolvedAt: new Date(),
        adminNote,
      }
      appendAudit(dispute, {
        fromStatus: prev,
        toStatus: 'RESOLVED_REJECTED',
        action: 'REJECT_DRIVER_COMPLAINT',
        actorId: adminId,
        actorRole: 'admin',
        note: adminNote,
      })
      await dispute.save()

      const driver = await Driver.findById(dispute.driverId)
      if (driver) {
        driver.paymentCompliance = driver.paymentCompliance || {}
        driver.paymentCompliance.falseComplaintCount =
          (driver.paymentCompliance.falseComplaintCount || 0) + 1
        driver.paymentCompliance.fraudScore =
          (driver.paymentCompliance.fraudScore || 0) + 1
        if (
          driver.paymentCompliance.falseComplaintCount >=
          policy.driverFalseComplaintSuspendThreshold
        ) {
          const days = 7
          driver.paymentCompliance.suspendedUntil = new Date(
            Date.now() + days * 24 * 60 * 60 * 1000
          )
          driver.isActive = false
        }
        await driver.save()
      }

      await Ride.findByIdAndUpdate(dispute.rideId, {
        'paymentCollection.status': 'paid',
        'paymentCollection.activeDisputeId': null,
        paymentStatus: 'completed',
        'paymentCollection.amountRemaining': 0,
      })

      await recalcRiderPendingDues(dispute.riderId)

      await notifyPaymentDispute({
        recipientId: dispute.driverId,
        recipientModel: 'Driver',
        templateKey: 'DISPUTE_REJECTED',
        rideId: dispute.rideId,
        disputeId: dispute._id,
      })
      break
    }

    case 'WAIVE': {
      dispute.status = 'CANCELLED'
      dispute.resolution = {
        outcome: 'WAIVED',
        resolvedBy: adminId,
        resolvedAt: new Date(),
        adminNote,
      }
      appendAudit(dispute, {
        fromStatus: prev,
        toStatus: 'CANCELLED',
        action: 'WAIVE',
        actorId: adminId,
        actorRole: 'admin',
      })
      await dispute.save()
      await Ride.findByIdAndUpdate(dispute.rideId, {
        'paymentCollection.activeDisputeId': null,
        'paymentCollection.status': 'paid',
        paymentStatus: 'completed',
        'paymentCollection.amountRemaining': 0,
      })
      await recalcRiderPendingDues(dispute.riderId)
      break
    }

    case 'COMPANY_SETTLE': {
      const amount = roundInr(compensationAmount || dispute.paymentContext?.fare || 0)
      dispute.status = 'RESOLVED_COMPANY_SETTLED'
      dispute.issueType = 'COMPANY_SETTLED'
      dispute.resolution = {
        outcome: 'COMPANY_SETTLED',
        resolvedBy: adminId,
        resolvedAt: new Date(),
        adminNote,
      }
      appendAudit(dispute, {
        fromStatus: prev,
        toStatus: 'RESOLVED_COMPANY_SETTLED',
        action: 'COMPANY_SETTLE',
        actorId: adminId,
        actorRole: 'admin',
        note: adminNote,
      })
      await dispute.save()

      await InternalSettlement.create({
        disputeId: dispute._id,
        rideId: dispute.rideId,
        driverId: dispute.driverId,
        compensationAmount: amount,
        reason: 'COMPANY_SETTLED',
        adminNote,
        settledBy: adminId,
      })

      await Ride.findByIdAndUpdate(dispute.rideId, {
        'paymentCollection.status': 'company_settled',
        'paymentCollection.activeDisputeId': null,
        'paymentCollection.amountRemaining': 0,
        paymentStatus: 'completed',
      })

      await recalcRiderPendingDues(dispute.riderId)

      await notifyPaymentDispute({
        recipientId: dispute.driverId,
        recipientModel: 'Driver',
        templateKey: 'PAYMENT_RECEIVED_SUCCESS',
        rideId: dispute.rideId,
        disputeId: dispute._id,
      })
      break
    }

    case 'VERIFY_PAYMENT_CAPTURED': {
      await resolveDisputePaid({
        dispute,
        resolvedBy: adminId,
        actorRole: 'admin',
        outcome: 'GATEWAY_VERIFIED',
      })
      break
    }

    default:
      throw new Error(`Unknown admin action: ${action}`)
  }

  return PaymentDispute.findById(disputeId).populate('rideId riderId driverId')
}

const payAllPendingDuesWithWallet = async ({ riderId, idempotencyKey }) => {
  const UserModel = User
  const WalletTransaction = require('../../Models/User/walletTransaction.model')
  const { listPendingDuesForRider } = require('./dues.service')

  const dues = await listPendingDuesForRider(riderId)
  const total = roundInr(dues.totalPendingDues)
  if (total <= 0) {
    return { paid: 0, disputes: [] }
  }

  const user = await UserModel.findById(riderId)
  if (!user) throw new Error('Rider not found')
  if ((user.walletBalance || 0) < total) {
    throw new Error(`Insufficient wallet balance. Need ₹${total}`)
  }

  if (idempotencyKey) {
    const existing = await PaymentDispute.findOne({
      recoveryPaymentId: idempotencyKey,
      riderId,
      status: 'RESOLVED_PAID',
    })
    if (existing) {
      return { paid: total, disputes: [existing._id], idempotent: true }
    }
  }

  user.walletBalance = roundInr(user.walletBalance - total)
  await user.save()

  await WalletTransaction.create({
    user: riderId,
    amount: -total,
    transactionType: 'RIDE_PAYMENT',
    status: 'COMPLETED',
    description: `Pending ride dues recovery (${dues.items.length} dispute(s))`,
    metadata: { idempotencyKey, disputeIds: dues.items.map((i) => i.disputeId) },
  })

  const resolved = []
  for (const item of dues.items) {
    const dispute = await PaymentDispute.findById(item.disputeId)
    if (dispute && !TERMINAL_STATUSES.includes(dispute.status)) {
      if (idempotencyKey) {
        dispute.recoveryPaymentId = idempotencyKey
      }
      await resolveDisputePaid({
        dispute,
        resolvedBy: riderId,
        actorRole: 'rider',
        outcome: 'WALLET_RECOVERY',
        recoveryPaymentId: idempotencyKey,
      })
      resolved.push(dispute._id)
    }
  }

  await recalcRiderPendingDues(riderId)
  return { paid: total, disputes: resolved }
}

const autoCloseDispute = async (dispute, outcome = 'AUTO_CLOSED') => {
  const prev = dispute.status
  dispute.status = outcome === 'AUTO_CLOSED' ? 'AUTO_CLOSED' : 'RESOLVED_PAID'
  dispute.resolution = {
    outcome,
    resolvedAt: new Date(),
    resolvedBy: null,
  }
  appendAudit(dispute, {
    fromStatus: prev,
    toStatus: dispute.status,
    action: outcome,
    actorRole: 'system',
  })
  await dispute.save()
  return dispute
}

module.exports = {
  REVIEW_ISSUE_TYPES,
  getActiveDisputeForRide,
  createDriverDispute,
  addEvidence,
  driverConfirmPaymentReceived,
  resolveDisputePaid,
  adminResolveDispute,
  payAllPendingDuesWithWallet,
  autoCloseDispute,
  appendAudit,
}
