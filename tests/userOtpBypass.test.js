const { test, describe, beforeEach, afterEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { redis } = require('../config/redis')
redis.disconnect()

const User = require('../Models/User/user.model')
const {
  loginUserByMobile,
  resendUserLoginOtp,
  verifyUserLoginOtp
} = require('../Controllers/User/user.controller')

describe('User OTP Bypass Direct Login', () => {
  after(() => {
    redis.disconnect()
  })
  let originalFindOne
  let originalUserSave
  let originalFetch
  let fetchCallCount = 0

  beforeEach(() => {
    originalFindOne = User.findOne
    originalUserSave = User.prototype.save
    originalFetch = globalThis.fetch
    fetchCallCount = 0

    // Spy on fetch to ensure MSG91 is never invoked for bypass numbers
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
    User.findOne = originalFindOne
    User.prototype.save = originalUserSave
    globalThis.fetch = originalFetch
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

  test('POST /users/login directly logs in for 8007477149 without sending OTP', async () => {
    const mockUser = {
      _id: 'mock_user_8007477149',
      phoneNumber: '8007477149',
      isActive: true,
      privacyPolicyAccepted: true,
      save: async function () { return this }
    }
    User.findOne = async () => mockUser

    const req = {
      body: { phoneNumber: '8007477149' }
    }

    const { status, data } = await invokeController(loginUserByMobile, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.equal(data.phoneNumber, '8007477149')
    assert.ok(data.token, 'Should issue a JWT token')
    assert.equal(fetchCallCount, 0, 'No MSG91 OTP call must be made')
  })

  test('POST /users/login directly logs in for 9403884093 without sending OTP', async () => {
    const mockUser = {
      _id: 'mock_user_9403884093',
      phoneNumber: '9403884093',
      isActive: true,
      privacyPolicyAccepted: true,
      save: async function () { return this }
    }
    User.findOne = async () => mockUser

    const req = {
      body: { phoneNumber: '+919403884093' }
    }

    const { status, data } = await invokeController(loginUserByMobile, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.equal(data.phoneNumber, '9403884093')
    assert.ok(data.token, 'Should issue a JWT token')
    assert.equal(fetchCallCount, 0, 'No MSG91 OTP call must be made')
  })

  test('POST /users/login sends OTP for normal phone numbers', async () => {
    User.findOne = async () => null

    const req = {
      body: { phoneNumber: '9876543210' }
    }

    const { status, data } = await invokeController(loginUserByMobile, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.message, 'OTP sent successfully')
    assert.equal(data.directLogin, undefined)
    assert.equal(fetchCallCount, 1, 'MSG91 OTP call should be made for standard numbers')
  })

  test('POST /users/login/verify directly grants access for 8007477149 without MSG91 verify', async () => {
    const mockUser = {
      _id: 'mock_user_8007477149',
      phoneNumber: '8007477149',
      isActive: true,
      privacyPolicyAccepted: true,
      save: async function () { return this }
    }
    User.findOne = async () => mockUser

    const req = {
      body: { phoneNumber: '8007477149' }
    }

    const { status, data } = await invokeController(verifyUserLoginOtp, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.ok(data.token)
    assert.equal(fetchCallCount, 0, 'No MSG91 verify call must be made')
  })

  test('GET /users/login/resend-otp returns direct login status without MSG91 call for bypass number', async () => {
    const req = {
      query: { phoneNumber: '8007477149' }
    }

    const { status, data } = await invokeController(resendUserLoginOtp, req)

    assert.equal(status, 200)
    assert.equal(data.success, true)
    assert.equal(data.directLogin, true)
    assert.equal(fetchCallCount, 0, 'No MSG91 resend call must be made')
  })
})
