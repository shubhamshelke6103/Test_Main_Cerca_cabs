const { test } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')
const {
  getDriverApprovalSummary,
  setDriverPendingApproval,
  rejectDriverApproval,
  DRIVER_APPROVAL_STATUS,
  DRIVER_APPROVAL_ACTOR,
} = require('../utils/driverApproval.service')

test('setDriverPendingApproval after admin rejection returns PENDING_ADMIN', () => {
  const driver = {
    vendorId: null,
    isVerified: false,
    isActive: false,
    rejectionReason: null,
    approvalWorkflow: {
      status: DRIVER_APPROVAL_STATUS.PENDING_ADMIN,
      routedTo: DRIVER_APPROVAL_ACTOR.ADMIN,
      submittedAt: new Date(),
      vendorApprovedAt: null,
      adminApprovedAt: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
    },
  }
  rejectDriverApproval(driver, DRIVER_APPROVAL_ACTOR.ADMIN, 'Fix documents')
  assert.equal(getDriverApprovalSummary(driver).status, DRIVER_APPROVAL_STATUS.REJECTED)
  setDriverPendingApproval(driver)
  assert.equal(getDriverApprovalSummary(driver).status, DRIVER_APPROVAL_STATUS.PENDING_ADMIN)
  assert.equal(driver.rejectionReason, null)
})

test('setDriverPendingApproval after vendor rejection returns PENDING_VENDOR', () => {
  const driver = {
    vendorId: new mongoose.Types.ObjectId(),
    isVerified: false,
    isActive: false,
    rejectionReason: null,
    approvalWorkflow: {
      status: DRIVER_APPROVAL_STATUS.PENDING_VENDOR,
      routedTo: DRIVER_APPROVAL_ACTOR.VENDOR,
      submittedAt: new Date(),
      vendorApprovedAt: null,
      adminApprovedAt: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
    },
  }
  rejectDriverApproval(driver, DRIVER_APPROVAL_ACTOR.VENDOR, 'Fix vendor step')
  assert.equal(getDriverApprovalSummary(driver).status, DRIVER_APPROVAL_STATUS.REJECTED)
  setDriverPendingApproval(driver)
  assert.equal(getDriverApprovalSummary(driver).status, DRIVER_APPROVAL_STATUS.PENDING_VENDOR)
})
