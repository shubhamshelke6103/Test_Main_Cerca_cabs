const { test } = require('node:test')
const assert = require('node:assert/strict')

process.env.MSG91_AUTHKEY = process.env.MSG91_AUTHKEY || 'test-auth-key'
process.env.MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID || 'test-template-id'

const originalFetch = globalThis.fetch
const { verifyLoginOtp } = require('../utils/msg91Otp.service')

function mockResponse({ ok, status, body }) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body)
    }
  }
}

test('verifyLoginOtp maps incorrect OTP to INVALID_OTP', async () => {
  globalThis.fetch = async () =>
    mockResponse({
      ok: false,
      status: 400,
      body: {
        type: 'error',
        message: 'The OTP you entered is incorrect.'
      }
    })

  await assert.rejects(
    () => verifyLoginOtp({ mobile: '919403884093', otp: '1234' }),
    error => {
      assert.equal(error.code, 'INVALID_OTP')
      assert.equal(error.message, 'The OTP you entered is incorrect.')
      assert.equal(error.statusCode, 400)
      return true
    }
  )
})

test('verifyLoginOtp maps expired OTP to OTP_EXPIRED', async () => {
  globalThis.fetch = async () =>
    mockResponse({
      ok: false,
      status: 400,
      body: {
        type: 'error',
        message: 'OTP has expired. Please request a new one.'
      }
    })

  await assert.rejects(
    () => verifyLoginOtp({ mobile: '919403884093', otp: '1234' }),
    error => {
      assert.equal(error.code, 'OTP_EXPIRED')
      assert.equal(error.message, 'OTP has expired. Please request a new one.')
      assert.equal(error.statusCode, 400)
      return true
    }
  )
})

test.after(() => {
  globalThis.fetch = originalFetch
})
