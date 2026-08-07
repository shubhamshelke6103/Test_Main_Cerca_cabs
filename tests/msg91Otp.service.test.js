const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeMobileForMsg91
} = require('../utils/msg91Otp.service')

test('normalizeMobileForMsg91 accepts 10-digit mobile numbers', () => {
  const result = normalizeMobileForMsg91('9403884093')

  assert.equal(result.error, null)
  assert.deepEqual(result.value, {
    local: '9403884093',
    international: '919403884093'
  })
})

test('normalizeMobileForMsg91 accepts 91-prefixed mobile numbers', () => {
  const result = normalizeMobileForMsg91('+91 9403884093')

  assert.equal(result.error, null)
  assert.deepEqual(result.value, {
    local: '9403884093',
    international: '919403884093'
  })
})

test('normalizeMobileForMsg91 rejects invalid mobile numbers', () => {
  const result = normalizeMobileForMsg91('12345')

  assert.equal(result.error, 'Please enter a valid 10-digit mobile number')
  assert.equal(result.value, null)
})
