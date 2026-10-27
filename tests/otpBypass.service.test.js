const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  DEFAULT_BYPASS_NUMBERS,
  getBypassNumbers,
  isOtpBypassNumber,
  isOtpBypassRequest
} = require('../utils/otpBypass.service')

describe('otpBypass.service', () => {
  test('DEFAULT_BYPASS_NUMBERS contains 8007477149 and 9403884093', () => {
    assert.deepEqual(DEFAULT_BYPASS_NUMBERS, ['8007477149', '9403884093'])
    assert.ok(getBypassNumbers().includes('8007477149'))
    assert.ok(getBypassNumbers().includes('9403884093'))
  })

  test('isOtpBypassNumber matches 8007477149 in various phone formats', () => {
    assert.equal(isOtpBypassNumber('8007477149'), true)
    assert.equal(isOtpBypassNumber('+918007477149'), true)
    assert.equal(isOtpBypassNumber('918007477149'), true)
    assert.equal(isOtpBypassNumber('08007477149'), true)
    assert.equal(isOtpBypassNumber(8007477149), true)
  })

  test('isOtpBypassNumber matches 9403884093 in various phone formats', () => {
    assert.equal(isOtpBypassNumber('9403884093'), true)
    assert.equal(isOtpBypassNumber('+919403884093'), true)
    assert.equal(isOtpBypassNumber('919403884093'), true)
    assert.equal(isOtpBypassNumber('09403884093'), true)
    assert.equal(isOtpBypassNumber(9403884093), true)
  })

  test('isOtpBypassNumber returns false for non-whitelisted numbers', () => {
    assert.equal(isOtpBypassNumber('9876543210'), false)
    assert.equal(isOtpBypassNumber('+919876543210'), false)
    assert.equal(isOtpBypassNumber('9999999999'), false)
    assert.equal(isOtpBypassNumber(''), false)
    assert.equal(isOtpBypassNumber(null), false)
    assert.equal(isOtpBypassNumber(undefined), false)
  })

  test('isOtpBypassRequest identifies bypass numbers from body or query', () => {
    assert.equal(isOtpBypassRequest({ body: { phoneNumber: '8007477149' } }), true)
    assert.equal(isOtpBypassRequest({ body: { phone: '+919403884093' } }), true)
    assert.equal(isOtpBypassRequest({ query: { phoneNumber: '8007477149' } }), true)
    assert.equal(isOtpBypassRequest({ query: { phone: '9403884093' } }), true)

    assert.equal(isOtpBypassRequest({ body: { phoneNumber: '9876543210' } }), false)
    assert.equal(isOtpBypassRequest({}), false)
    assert.equal(isOtpBypassRequest(null), false)
  })
})

