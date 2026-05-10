const assert = require('assert')
const {
  deriveAdminEarningsSettlementFields
} = require('../utils/adminEarningsSettlement')

;(() => {
  const cashPending = deriveAdminEarningsSettlementFields(
    { paymentMethod: 'CASH', paymentStatus: 'pending' },
    20
  )
  assert.strictEqual(cashPending.paymentStatus, 'pending')
  assert.strictEqual(cashPending.driverPayoutEligible, false)

  const cashDone = deriveAdminEarningsSettlementFields(
    { paymentMethod: 'CASH', paymentStatus: 'completed' },
    20
  )
  assert.strictEqual(cashDone.paymentStatus, 'completed')
  assert.strictEqual(cashDone.cashPlatformReceivable.status, 'outstanding')
  assert.strictEqual(cashDone.cashPlatformReceivable.amount, 20)
  assert.strictEqual(cashDone.driverPayoutEligible, false)

  const walletDone = deriveAdminEarningsSettlementFields(
    { paymentMethod: 'WALLET', paymentStatus: 'completed' },
    15
  )
  assert.strictEqual(walletDone.driverPayoutEligible, true)
  assert.strictEqual(walletDone.cashPlatformReceivable, undefined)
  assert.strictEqual(walletDone.riderFundsStatus, 'captured')

  console.log('adminEarningsSettlement.test.js: ok')
})()
