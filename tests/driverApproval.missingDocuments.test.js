const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  getMissingDriverApprovalDocuments
} = require('../utils/driverApproval.service')

test('returns all three types when complianceDocuments empty', () => {
  const missing = getMissingDriverApprovalDocuments({ complianceDocuments: [] })
  assert.deepEqual(new Set(missing), new Set(['AADHAAR', 'DRIVING_LICENSE', 'PAN']))
})

test('returns empty when all required types present (normalized)', () => {
  const driver = {
    complianceDocuments: [
      { documentType: 'aadhaar' },
      { documentType: 'DRIVING-LICENSE' },
      { documentType: 'pan' }
    ]
  }
  assert.equal(getMissingDriverApprovalDocuments(driver).length, 0)
})
