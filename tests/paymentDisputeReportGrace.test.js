'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const mongoose = require('mongoose')

describe('payment dispute report grace', () => {
  let originalGraceEnv

  beforeEach(() => {
    originalGraceEnv = process.env.PAYMENT_DISPUTE_GRACE_MINUTES
  })

  afterEach(() => {
    if (originalGraceEnv === undefined) {
      delete process.env.PAYMENT_DISPUTE_GRACE_MINUTES
    } else {
      process.env.PAYMENT_DISPUTE_GRACE_MINUTES = originalGraceEnv
    }
    const { clearPolicyCache } = require('../utils/paymentDispute/policy')
    clearPolicyCache()
  })

  it('resolveDisputeReportGraceMinutes defaults to 0 when env unset', async () => {
    delete process.env.PAYMENT_DISPUTE_GRACE_MINUTES
    const { clearPolicyCache } = require('../utils/paymentDispute/policy')
    clearPolicyCache()
    const { resolveDisputeReportGraceMinutes } = require('../utils/paymentDispute/dispute.service')
    const minutes = await resolveDisputeReportGraceMinutes()
    assert.equal(minutes, 0)
  })

  it('resolveDisputeReportGraceMinutes uses PAYMENT_DISPUTE_GRACE_MINUTES when set', async () => {
    process.env.PAYMENT_DISPUTE_GRACE_MINUTES = '0'
    const { clearPolicyCache } = require('../utils/paymentDispute/policy')
    clearPolicyCache()
    const { resolveDisputeReportGraceMinutes } = require('../utils/paymentDispute/dispute.service')
    const minutes = await resolveDisputeReportGraceMinutes()
    assert.equal(minutes, 0)
  })

  it('grace window is satisfied when ride ended longer ago than grace minutes', async () => {
    process.env.PAYMENT_DISPUTE_GRACE_MINUTES = '15'
    const { clearPolicyCache } = require('../utils/paymentDispute/policy')
    clearPolicyCache()
    const { resolveDisputeReportGraceMinutes } = require('../utils/paymentDispute/dispute.service')
    const graceMinutes = await resolveDisputeReportGraceMinutes()
    const completedAt = new Date(Date.now() - 20 * 60 * 1000)
    const minReportAt = new Date(completedAt.getTime() + graceMinutes * 60 * 1000)
    assert.ok(new Date() >= minReportAt)
  })

  it('assertDriverCanReport throws GRACE_PERIOD_ACTIVE when within grace window', async () => {
    process.env.PAYMENT_DISPUTE_GRACE_MINUTES = '15'
    const { clearPolicyCache } = require('../utils/paymentDispute/policy')
    clearPolicyCache()
    const { assertDriverCanReport } = require('../utils/paymentDispute/dispute.service')

    const ride = {
      _id: new mongoose.Types.ObjectId(),
      status: 'completed',
      driver: 'driver1',
      actualEndTime: new Date(),
    }

    await assert.rejects(
      () => assertDriverCanReport(ride, 'driver1'),
      err => {
        assert.equal(err.code, 'GRACE_PERIOD_ACTIVE')
        assert.ok(err.minutesRemaining >= 1)
        return true
      }
    )
  })

  it('assertDriverCanReport throws RIDE_NOT_COMPLETED when ride not completed', async () => {
    process.env.PAYMENT_DISPUTE_GRACE_MINUTES = '0'
    const { assertDriverCanReport } = require('../utils/paymentDispute/dispute.service')

    const ride = {
      _id: 'ride1',
      status: 'in_progress',
      driver: 'driver1',
    }

    await assert.rejects(
      () => assertDriverCanReport(ride, 'driver1'),
      err => err.code === 'RIDE_NOT_COMPLETED'
    )
  })
})
