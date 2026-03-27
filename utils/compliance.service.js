const Driver = require('../Models/Driver/driver.model')
const Vendor = require('../Models/vendor/vendor.models')
const { notifyAdmins, notifyVendor } = require('./alerting.service')

const EXPIRY_WARNING_DAYS = 7
const REVERIFICATION_WARNING_DAYS = Number(
  process.env.REVERIFICATION_WARNING_DAYS || 15
)
const REVERIFICATION_CYCLE_DAYS = Number(
  process.env.REVERIFICATION_CYCLE_DAYS || 365
)

const getStatusForExpiry = expiryDate => {
  const expiry = new Date(expiryDate)
  const now = new Date()
  const warningDate = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 86400000)

  if (expiry < now) return 'expired'
  if (expiry <= warningDate) return 'expiring_soon'
  return 'valid'
}

const syncComplianceStatuses = documents =>
  (documents || []).map(document => {
    const normalized = {
      ...document,
      status: getStatusForExpiry(document.expiryDate)
    }
    const baselineDate = document.verifiedAt
      ? new Date(document.verifiedAt)
      : null
    if (baselineDate && !Number.isNaN(baselineDate.getTime())) {
      normalized.reverificationDueAt = new Date(
        baselineDate.getTime() + REVERIFICATION_CYCLE_DAYS * 86400000
      )
    } else {
      normalized.reverificationDueAt = null
    }

    // Renewal-safe reset of old alert markers when expiry moved to a healthy future date.
    if (normalized.status === 'valid') {
      normalized.alertSentBeforeExpiryAt = null
      normalized.alertSentAfterExpiryAt = null
      normalized.alertSentBeforeReverificationAt = null
      normalized.alertSentAfterReverificationAt = null
    }

    return normalized
  })

const getReverificationState = document => {
  if (!document?.reverificationDueAt) return 'not_applicable'
  const now = new Date()
  const dueAt = new Date(document.reverificationDueAt)
  if (Number.isNaN(dueAt.getTime())) return 'not_applicable'
  if (dueAt < now) return 'overdue'
  const warningDate = new Date(
    now.getTime() + REVERIFICATION_WARNING_DAYS * 86400000
  )
  if (dueAt <= warningDate) return 'due_soon'
  return 'up_to_date'
}

const processComplianceAlerts = async () => {
  const drivers = await Driver.find({
    complianceDocuments: { $exists: true, $ne: [] }
  }).select('name vendorId complianceDocuments')

  const vendors = await Vendor.find({
    complianceDocuments: { $exists: true, $ne: [] }
  }).select('businessName complianceDocuments')

  for (const driver of drivers) {
    let hasChanges = false
    for (const document of driver.complianceDocuments) {
      const status = getStatusForExpiry(document.expiryDate)
      if (document.status !== status) {
        document.status = status
        hasChanges = true
      }

      const synced = syncComplianceStatuses([document])[0]
      if (
        synced.reverificationDueAt &&
        new Date(synced.reverificationDueAt).toISOString() !==
          new Date(document.reverificationDueAt || 0).toISOString()
      ) {
        document.reverificationDueAt = synced.reverificationDueAt
        hasChanges = true
      }

      if (status === 'valid') {
        if (
          document.alertSentBeforeExpiryAt ||
          document.alertSentAfterExpiryAt ||
          document.alertSentBeforeReverificationAt ||
          document.alertSentAfterReverificationAt
        ) {
          document.alertSentBeforeExpiryAt = null
          document.alertSentAfterExpiryAt = null
          document.alertSentBeforeReverificationAt = null
          document.alertSentAfterReverificationAt = null
          hasChanges = true
        }
      }

      if (
        status === 'expiring_soon' &&
        !document.alertSentBeforeExpiryAt
      ) {
        const message = `${document.documentType} for driver ${driver.name} is expiring on ${new Date(
          document.expiryDate
        ).toISOString().slice(0, 10)}`
        await notifyAdmins({
          title: 'Driver document expiring soon',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        await notifyVendor(driver.vendorId, {
          title: 'Driver document expiring soon',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        document.alertSentBeforeExpiryAt = new Date()
        hasChanges = true
      }

      if (status === 'expired' && !document.alertSentAfterExpiryAt) {
        const message = `${document.documentType} for driver ${driver.name} has expired`
        await notifyAdmins({
          title: 'Driver document expired',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        await notifyVendor(driver.vendorId, {
          title: 'Driver document expired',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        document.alertSentAfterExpiryAt = new Date()
        hasChanges = true
      }

      const reverificationState = getReverificationState(document)
      if (
        reverificationState === 'due_soon' &&
        !document.alertSentBeforeReverificationAt
      ) {
        const dueDate = new Date(document.reverificationDueAt)
          .toISOString()
          .slice(0, 10)
        const message = `${document.documentType} for driver ${driver.name} requires re-verification by ${dueDate}`
        await notifyAdmins({
          title: 'Driver document re-verification due soon',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        await notifyVendor(driver.vendorId, {
          title: 'Driver document re-verification due soon',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        document.alertSentBeforeReverificationAt = new Date()
        hasChanges = true
      }

      if (
        reverificationState === 'overdue' &&
        !document.alertSentAfterReverificationAt
      ) {
        const message = `${document.documentType} for driver ${driver.name} is overdue for re-verification`
        await notifyAdmins({
          title: 'Driver document re-verification overdue',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        await notifyVendor(driver.vendorId, {
          title: 'Driver document re-verification overdue',
          message,
          type: 'compliance_alert',
          data: { driverId: driver._id, documentType: document.documentType }
        })
        document.alertSentAfterReverificationAt = new Date()
        hasChanges = true
      }
    }

    if (hasChanges) {
      await driver.save()
    }
  }

  for (const vendor of vendors) {
    let hasChanges = false
    for (const document of vendor.complianceDocuments) {
      const status = getStatusForExpiry(document.expiryDate)
      if (document.status !== status) {
        document.status = status
        hasChanges = true
      }

      const synced = syncComplianceStatuses([document])[0]
      if (
        synced.reverificationDueAt &&
        new Date(synced.reverificationDueAt).toISOString() !==
          new Date(document.reverificationDueAt || 0).toISOString()
      ) {
        document.reverificationDueAt = synced.reverificationDueAt
        hasChanges = true
      }

      if (status === 'valid') {
        if (
          document.alertSentBeforeExpiryAt ||
          document.alertSentAfterExpiryAt ||
          document.alertSentBeforeReverificationAt ||
          document.alertSentAfterReverificationAt
        ) {
          document.alertSentBeforeExpiryAt = null
          document.alertSentAfterExpiryAt = null
          document.alertSentBeforeReverificationAt = null
          document.alertSentAfterReverificationAt = null
          hasChanges = true
        }
      }

      if (status === 'expiring_soon' && !document.alertSentBeforeExpiryAt) {
        const message = `${document.documentType} for vendor ${vendor.businessName} is expiring soon`
        await notifyAdmins({
          title: 'Vendor document expiring soon',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        await notifyVendor(vendor._id, {
          title: 'Vendor document expiring soon',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        document.alertSentBeforeExpiryAt = new Date()
        hasChanges = true
      }

      if (status === 'expired' && !document.alertSentAfterExpiryAt) {
        const message = `${document.documentType} for vendor ${vendor.businessName} has expired`
        await notifyAdmins({
          title: 'Vendor document expired',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        await notifyVendor(vendor._id, {
          title: 'Vendor document expired',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        document.alertSentAfterExpiryAt = new Date()
        hasChanges = true
      }

      const reverificationState = getReverificationState(document)
      if (
        reverificationState === 'due_soon' &&
        !document.alertSentBeforeReverificationAt
      ) {
        const dueDate = new Date(document.reverificationDueAt)
          .toISOString()
          .slice(0, 10)
        const message = `${document.documentType} for vendor ${vendor.businessName} requires re-verification by ${dueDate}`
        await notifyAdmins({
          title: 'Vendor document re-verification due soon',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        await notifyVendor(vendor._id, {
          title: 'Vendor document re-verification due soon',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        document.alertSentBeforeReverificationAt = new Date()
        hasChanges = true
      }

      if (
        reverificationState === 'overdue' &&
        !document.alertSentAfterReverificationAt
      ) {
        const message = `${document.documentType} for vendor ${vendor.businessName} is overdue for re-verification`
        await notifyAdmins({
          title: 'Vendor document re-verification overdue',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        await notifyVendor(vendor._id, {
          title: 'Vendor document re-verification overdue',
          message,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        document.alertSentAfterReverificationAt = new Date()
        hasChanges = true
      }
    }

    if (hasChanges) {
      await vendor.save()
    }
  }
}

module.exports = {
  processComplianceAlerts,
  syncComplianceStatuses
}
