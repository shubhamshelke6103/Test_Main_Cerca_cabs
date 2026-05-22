const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveTravelledDistanceKmBeforeStart,
  splitBeforeStartCancelPrepaid,
  walletBalanceAfterBeforeStartCancel,
  computePlatformSplitFromGrossFare,
  roundMoney
} = require('../utils/beforeStartCancelSettlement')

test('resolveTravelledDistanceKmBeforeStart uses max by default', () => {
  assert.equal(
    resolveTravelledDistanceKmBeforeStart({ polylineKm: 3, straightKm: 2, policy: 'max' }),
    3
  )
  assert.equal(
    resolveTravelledDistanceKmBeforeStart({ polylineKm: 1, straightKm: 4, policy: 'max' }),
    4
  )
})

test('resolveTravelledDistanceKmBeforeStart polyline_first falls back to straight', () => {
  assert.equal(
    resolveTravelledDistanceKmBeforeStart({
      polylineKm: 0,
      straightKm: 2.5,
      policy: 'polyline_first'
    }),
    2.5
  )
})

test('splitBeforeStartCancelPrepaid: wallet-only surplus refunds to wallet math', () => {
  const split = splitBeforeStartCancelPrepaid({ Pw: 100, Pr: 0, O: 50 })
  assert.equal(split.use_w, 50)
  assert.equal(split.use_r, 0)
  assert.equal(split.shortfall, 0)
  assert.equal(split.razorpayRefund, 0)
  const W0 = 400
  const Wcur = W0 - 100
  const Wnew = walletBalanceAfterBeforeStartCancel(Wcur, 100, {
    use_w: split.use_w,
    shortfall: split.shortfall
  })
  assert.equal(Wnew, roundMoney(W0 - 50))
})

test('splitBeforeStartCancelPrepaid: shortfall drives negative wallet', () => {
  const split = splitBeforeStartCancelPrepaid({ Pw: 0, Pr: 0, O: 50 })
  assert.equal(split.shortfall, 50)
  const Wnew = walletBalanceAfterBeforeStartCancel(0, 0, {
    use_w: 0,
    shortfall: split.shortfall
  })
  assert.equal(Wnew, -50)
})

test('splitBeforeStartCancelPrepaid: hybrid consumes razorpay then refunds remainder', () => {
  const split = splitBeforeStartCancelPrepaid({ Pw: 30, Pr: 70, O: 50 })
  assert.equal(split.use_w, 30)
  assert.equal(split.use_r, 20)
  assert.equal(split.shortfall, 0)
  assert.equal(split.razorpayRefund, 50)
})

test('computePlatformSplitFromGrossFare uses the ride formula', () => {
  const { platformFee, driverEarning } = computePlatformSplitFromGrossFare(100, {
    platformFees: 20,
    driverCommissions: 80
  })
  assert.equal(platformFee, 5)
  assert.equal(driverEarning, 95)
})
