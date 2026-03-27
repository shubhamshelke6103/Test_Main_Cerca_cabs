const DRIVER_APPROVAL_STATUS = {
  PENDING_VENDOR: 'PENDING_VENDOR',
  PENDING_ADMIN: 'PENDING_ADMIN',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
}

const DRIVER_APPROVAL_ACTOR = {
  VENDOR: 'VENDOR',
  ADMIN: 'ADMIN'
}

const REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES = [
  'AADHAAR',
  'DRIVING_LICENSE',
  'PAN'
]

const normalizeDocumentType = value => {
  if (typeof value !== 'string') return ''

  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
}

const getMissingDriverApprovalDocuments = driver => {
  const availableDocumentTypes = new Set(
    (driver?.complianceDocuments || []).map(document =>
      normalizeDocumentType(document?.documentType)
    )
  )

  return REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES.filter(
    documentType => !availableDocumentTypes.has(documentType)
  )
}

const buildInitialApprovalWorkflow = vendorId => ({
  status: vendorId
    ? DRIVER_APPROVAL_STATUS.PENDING_VENDOR
    : DRIVER_APPROVAL_STATUS.PENDING_ADMIN,
  routedTo: vendorId ? DRIVER_APPROVAL_ACTOR.VENDOR : DRIVER_APPROVAL_ACTOR.ADMIN,
  submittedAt: new Date(),
  vendorApprovedAt: null,
  adminApprovedAt: null,
  rejectedAt: null,
  rejectedBy: null,
  rejectionReason: null
})

const resolveDriverApprovalWorkflow = driver => {
  if (driver?.approvalWorkflow?.status) {
    return {
      ...driver.approvalWorkflow.toObject?.() || driver.approvalWorkflow,
      routedTo:
        driver.approvalWorkflow.routedTo ||
        (driver.approvalWorkflow.status === DRIVER_APPROVAL_STATUS.PENDING_VENDOR
          ? DRIVER_APPROVAL_ACTOR.VENDOR
          : driver.approvalWorkflow.status === DRIVER_APPROVAL_STATUS.PENDING_ADMIN
            ? DRIVER_APPROVAL_ACTOR.ADMIN
            : null)
    }
  }

  if (driver?.isVerified) {
    return {
      status: DRIVER_APPROVAL_STATUS.APPROVED,
      routedTo: null,
      submittedAt: driver?.createdAt || null,
      vendorApprovedAt: null,
      adminApprovedAt: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null
    }
  }

  if (driver?.rejectionReason) {
    return {
      status: DRIVER_APPROVAL_STATUS.REJECTED,
      routedTo: driver?.vendorId ? DRIVER_APPROVAL_ACTOR.VENDOR : DRIVER_APPROVAL_ACTOR.ADMIN,
      submittedAt: driver?.createdAt || null,
      vendorApprovedAt: null,
      adminApprovedAt: null,
      rejectedAt: null,
      rejectedBy: driver?.vendorId ? DRIVER_APPROVAL_ACTOR.VENDOR : DRIVER_APPROVAL_ACTOR.ADMIN,
      rejectionReason: driver.rejectionReason
    }
  }

  return buildInitialApprovalWorkflow(driver?.vendorId)
}

const setDriverApprovalWorkflow = (driver, workflow) => {
  driver.approvalWorkflow = workflow
  return driver.approvalWorkflow
}

const setDriverPendingApproval = driver => {
  setDriverApprovalWorkflow(driver, buildInitialApprovalWorkflow(driver.vendorId))
  driver.isVerified = false
  driver.isActive = false
  driver.rejectionReason = null
  return driver
}

const vendorApproveDriver = driver => {
  const workflow = resolveDriverApprovalWorkflow(driver)

  if (!driver.vendorId) {
    throw new Error('Only vendor-linked drivers can be vendor-approved')
  }

  if (workflow.status !== DRIVER_APPROVAL_STATUS.PENDING_VENDOR) {
    throw new Error('Driver is not pending vendor approval')
  }

  setDriverApprovalWorkflow(driver, {
    ...workflow,
    status: DRIVER_APPROVAL_STATUS.PENDING_ADMIN,
    routedTo: DRIVER_APPROVAL_ACTOR.ADMIN,
    vendorApprovedAt: new Date(),
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null
  })

  driver.isVerified = false
  driver.isActive = false
  driver.rejectionReason = null

  return driver
}

const adminApproveDriver = driver => {
  const workflow = resolveDriverApprovalWorkflow(driver)
  const requiresVendorApproval = Boolean(driver.vendorId)

  if (
    requiresVendorApproval &&
    workflow.status !== DRIVER_APPROVAL_STATUS.PENDING_ADMIN
  ) {
    throw new Error('Vendor approval must be completed before admin approval')
  }

  if (
    !requiresVendorApproval &&
    workflow.status !== DRIVER_APPROVAL_STATUS.PENDING_ADMIN
  ) {
    throw new Error('Driver is not pending admin approval')
  }

  setDriverApprovalWorkflow(driver, {
    ...workflow,
    status: DRIVER_APPROVAL_STATUS.APPROVED,
    routedTo: null,
    adminApprovedAt: new Date(),
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null
  })

  driver.isVerified = true
  driver.isActive = true
  driver.rejectionReason = null

  return driver
}

const rejectDriverApproval = (driver, actor, reason) => {
  const workflow = resolveDriverApprovalWorkflow(driver)

  if (
    actor === DRIVER_APPROVAL_ACTOR.VENDOR &&
    workflow.status !== DRIVER_APPROVAL_STATUS.PENDING_VENDOR
  ) {
    throw new Error('Driver is not pending vendor approval')
  }

  if (
    actor === DRIVER_APPROVAL_ACTOR.ADMIN &&
    workflow.status !== DRIVER_APPROVAL_STATUS.PENDING_ADMIN
  ) {
    throw new Error('Driver is not pending admin approval')
  }

  setDriverApprovalWorkflow(driver, {
    ...workflow,
    status: DRIVER_APPROVAL_STATUS.REJECTED,
    routedTo: actor,
    rejectedAt: new Date(),
    rejectedBy: actor,
    rejectionReason: reason
  })

  driver.isVerified = false
  driver.isActive = false
  driver.rejectionReason = reason

  return driver
}

const getDriverApprovalSummary = driver => {
  const workflow = resolveDriverApprovalWorkflow(driver)

  return {
    status: workflow.status,
    routedTo: workflow.routedTo || null,
    submittedAt: workflow.submittedAt || null,
    vendorApprovedAt: workflow.vendorApprovedAt || null,
    adminApprovedAt: workflow.adminApprovedAt || null,
    rejectedAt: workflow.rejectedAt || null,
    rejectedBy: workflow.rejectedBy || null,
    rejectionReason: workflow.rejectionReason || driver?.rejectionReason || null
  }
}

module.exports = {
  DRIVER_APPROVAL_STATUS,
  DRIVER_APPROVAL_ACTOR,
  REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES,
  getMissingDriverApprovalDocuments,
  buildInitialApprovalWorkflow,
  resolveDriverApprovalWorkflow,
  setDriverPendingApproval,
  vendorApproveDriver,
  adminApproveDriver,
  rejectDriverApproval,
  getDriverApprovalSummary
}
