const { test, describe, beforeEach, afterEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { redis } = require('../config/redis')
redis.disconnect()

const Driver = require('../Models/Driver/driver.model')
const {
  loginDriver,
  resendDriverLoginOtp,
  verifyDriverLoginOtp
} = require('../Controllers/Driver/driver.controller')

describe('Driver OTP Bypass Direct Login', () => {
  let originalFindOne
  let originalDriverSave
  let originalFetch
  let fetchCallCount = 0

  beforeEach(() => {
    originalFindOne = Driver.findOne
    originalDriverSave = Driver.prototype.save
    originalFetch = globalThis.fetch
    fetchCallCount = 0

    globalThis.fetch = async () => {
      fetchCallCount++
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ type: 'success', message: 'OTP sent' })
        }
      }
    }
  })

  afterEach(() => {
    Driver.findOne = originalFindOne
    Driver.prototype.save = originalDriverSave
    globalThis.fetch = originalFetch
  })

  after(() => {
    redis.disconnect()
  })

  const invokeController = (handler, req) => {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code
          return this
        },
        json(data) {
          resolve({ status: this.statusCode, data })
          return this
        }
      }
      handler(req, res, err => {
        if (err) reject(err)
      })
    })
  }

  test('POST /drivers/login directly logs in for 8007477149 without sending OTP', async () => {
    const mockDriver = {
      _id: 'mock_driver_8007477149',
      phone: '8007477149',
      email: 'driver8007477149@cerca.app',
      isActive: true,
      approvalStatus: 'approved',
      save: async function () { return this }
    }
    Driver.findOne = async () => mockDriver

    const req = {
      body: { phone: '8007477149' }
    }

    const { status, data } = await invokeController(loginDriver, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.equal(data.phone, '8007477149')
    assert.ok(data.token, 'Should issue a JWT token')
    assert.equal(fetchCallCount, 0, 'No MSG91 OTP call must be made')
  })

  test('POST /drivers/login directly logs in for 9403884093 without sending OTP', async () => {
    const mockDriver = {
      _id: 'mock_driver_9403884093',
      phone: '9403884093',
      email: 'driver9403884093@cerca.app',
      isActive: true,
      approvalStatus: 'approved',
      save: async function () { return this }
    }
    Driver.findOne = async () => mockDriver

    const req = {
      body: { phoneNumber: '+919403884093' }
    }

    const { status, data } = await invokeController(loginDriver, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.equal(data.phone, '9403884093')
    assert.ok(data.token, 'Should issue a JWT token')
    assert.equal(fetchCallCount, 0, 'No MSG91 OTP call must be made')
  })

  test('POST /drivers/login sends OTP for normal phone numbers', async () => {
    const mockDriver = {
      _id: 'mock_driver_normal',
      phone: '9876543210',
      email: 'driver_normal@cerca.app',
      isActive: true,
      approvalStatus: 'approved',
      save: async function () { return this }
    }
    Driver.findOne = async () => mockDriver

    const req = {
      body: { phone: '9876543210' }
    }

    const { status, data } = await invokeController(loginDriver, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.message, 'OTP sent successfully')
    assert.equal(data.directLogin, undefined)
    assert.equal(fetchCallCount, 1, 'MSG91 OTP call should be made for standard numbers')
  })

  test('POST /drivers/login/verify directly grants access for 8007477149 without MSG91 verify', async () => {
    const mockDriver = {
      _id: 'mock_driver_8007477149',
      phone: '8007477149',
      email: 'driver8007477149@cerca.app',
      isActive: true,
      approvalStatus: 'approved',
      save: async function () { return this }
    }
    Driver.findOne = async () => mockDriver

    const req = {
      body: { phone: '8007477149' }
    }

    const { status, data } = await invokeController(verifyDriverLoginOtp, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.ok(data.token)
    assert.equal(fetchCallCount, 0, 'No MSG91 verify call must be made')
  })

  test('GET /drivers/login/resend-otp returns direct login status without MSG91 call for bypass number', async () => {
    const mockDriver = {
      _id: 'mock_driver_8007477149',
      phone: '8007477149',
      email: 'driver8007477149@cerca.app',
      isActive: true,
      approvalStatus: 'approved',
      save: async function () { return this }
    }
    Driver.findOne = async () => mockDriver

    const req = {
      query: { phoneNumber: '8007477149' }
    }

    const { status, data } = await invokeController(resendDriverLoginOtp, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.equal(fetchCallCount, 0, 'No MSG91 resend call must be made')
  })
})

