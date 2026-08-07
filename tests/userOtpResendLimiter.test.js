const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  getUserOtpResendRateLimitKey
} = require('../utils/otpRateLimitKey')

test('getUserOtpResendRateLimitKey uses the normalized mobile number', () => {
  const req = {
    query: { phoneNumber: '+91 9403884093' },
    ip: '127.0.0.1'
  }

  assert.equal(
    getUserOtpResendRateLimitKey(req),
    'mobile:919403884093'
  )
})

test('getUserOtpResendRateLimitKey falls back to IP when no mobile is present', () => {
  const req = {
    query: {},
    ip: '127.0.0.1'
  }

  assert.equal(getUserOtpResendRateLimitKey(req), 'ip:127.0.0.1')
})
