const assert = require('assert')
const {
  computeDriverNetSettlementFromEarnings,
  listUnpaidOnlineEarningsSortedForPayout
} = require('../utils/driverNetSettlementBalance')

function e (id, overrides) {
  return { _id: id, paymentStatus: 'completed', ...overrides }
}

;(() => {
  const paid = new Set()

  // Case 1: cash ride, commission outstanding
  let rows = [
    e('1', {
      paymentMethodSnapshot: 'CASH',
      platformFee: 100,
      driverEarning: 400,
      cashPlatformReceivable: { status: 'outstanding', amount: 100 }
    })
  ]
  let r = computeDriverNetSettlementFromEarnings(rows, paid)
  assert.strictEqual(r.netSettlementBalance, -100)
  assert.strictEqual(r.payoutableAmount, 0)
  assert.strictEqual(r.cashOwedToPlatformTotal, 100)
  assert.strictEqual(r.unpaidOnlineEarningsCount, 0)

  // Case 2: add online ride (driver earning 640)
  rows = [
    ...rows,
    e('2', {
      paymentMethodSnapshot: 'RAZORPAY',
      platformFee: 160,
      driverEarning: 640,
      rideId: { paymentMethod: 'RAZORPAY', tips: 0 }
    })
  ]
  r = computeDriverNetSettlementFromEarnings(rows, paid)
  assert.strictEqual(r.netSettlementBalance, 540)
  assert.strictEqual(r.payoutableAmount, 540)

  // Case 3: add cash ride, commission 200 outstanding
  rows = [
    ...rows,
    e('3', {
      paymentMethodSnapshot: 'CASH',
      platformFee: 200,
      driverEarning: 800,
      cashPlatformReceivable: { status: 'outstanding', amount: 200 }
    })
  ]
  r = computeDriverNetSettlementFromEarnings(rows, paid)
  assert.strictEqual(r.netSettlementBalance, 340)
  assert.strictEqual(r.payoutableAmount, 340)

  // Case 4: add online 480
  rows = [
    ...rows,
    e('4', {
      paymentMethodSnapshot: 'WALLET',
      platformFee: 120,
      driverEarning: 480,
      rideId: { tips: 0 }
    })
  ]
  r = computeDriverNetSettlementFromEarnings(rows, paid)
  assert.strictEqual(r.netSettlementBalance, 820)
  assert.strictEqual(r.payoutableAmount, 820)

  // Cash after admin collect: no longer subtract; still no +driverEarning for cash
  rows = [
    e('c1', {
      paymentMethodSnapshot: 'CASH',
      platformFee: 100,
      driverEarning: 400,
      cashPlatformReceivable: { status: 'settled', amount: 100 }
    })
  ]
  r = computeDriverNetSettlementFromEarnings(rows, paid)
  assert.strictEqual(r.netSettlementBalance, 0)
  assert.strictEqual(r.payoutableAmount, 0)

  // Online list excludes cash
  const mixed = [
    e('a', { paymentMethodSnapshot: 'CASH', driverEarning: 99 }),
    e('b', {
      paymentMethodSnapshot: 'WALLET',
      driverEarning: 10,
      rideDate: new Date('2026-01-02'),
      rideId: { tips: 5 }
    }),
    e('c', {
      paymentMethodSnapshot: 'WALLET',
      driverEarning: 20,
      rideDate: new Date('2026-01-01'),
      rideId: { tips: 0 }
    })
  ]
  const online = listUnpaidOnlineEarningsSortedForPayout(mixed, new Set())
  assert.strictEqual(online.length, 2)
  assert.strictEqual(online[0]._id, 'c')
  assert.strictEqual(online[1]._id, 'b')

  console.log('driverNetSettlementBalance.test.js: ok')
})()
