const Driver = require('../Models/Driver/driver.model')
const Vendor = require('../Models/vendor/vendor.models')
const { notifyAdmins, notifyVendor } = require('./alerting.service')

const EXPIRY_WARNING_DAYS = 7

const getStatusForExpiry = expiryDate => {
  const expiry = new Date(expiryDate)
  const now = new Date()
  const warningDate = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 86400000)

  if (expiry < now) return 'expired'
  if (expiry <= warningDate) return 'expiring_soon'
  return 'valid'
}

const syncComplianceStatuses = documents =>
  (documents || []).map(document => ({
    ...document,
    status: getStatusForExpiry(document.expiryDate)
  }))

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

      if (status === 'expiring_soon' && !document.alertSentBeforeExpiryAt) {
        await notifyAdmins({
          title: 'Vendor document expiring soon',
          message: `${document.documentType} for vendor ${vendor.businessName} is expiring soon`,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        document.alertSentBeforeExpiryAt = new Date()
        hasChanges = true
      }

      if (status === 'expired' && !document.alertSentAfterExpiryAt) {
        await notifyAdmins({
          title: 'Vendor document expired',
          message: `${document.documentType} for vendor ${vendor.businessName} has expired`,
          type: 'compliance_alert',
          data: { vendorId: vendor._id, documentType: document.documentType }
        })
        document.alertSentAfterExpiryAt = new Date()
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
