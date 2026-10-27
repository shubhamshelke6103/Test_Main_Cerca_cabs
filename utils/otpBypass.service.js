const { normalizeMobileForMsg91 } = require('./msg91Otp.service')
const { normalizeMobileDigits } = require('./contactValidation')

const DEFAULT_BYPASS_NUMBERS = ['8007477149', '9403884093']

const getBypassNumbers = () => {
  const envConfig = process.env.OTP_BYPASS_PHONE_NUMBERS
  if (typeof envConfig === 'string' && envConfig.trim().length > 0) {
    const list = envConfig
      .split(',')
      .map(num => {
        const normalized = normalizeMobileDigits(num)
        return normalized.value ? normalized.value.slice(-10) : null
      })
      .filter(Boolean)

    if (list.length > 0) {
      return [...new Set(list)]
    }
  }

  return [...DEFAULT_BYPASS_NUMBERS]
}

/**
 * Checks if the given mobile number matches any of the OTP bypass numbers.
 * Supports various formats: 10 digits, +91XXXXXXXXXX, 91XXXXXXXXXX, 0XXXXXXXXXX.
 *
 * @param {string|number} rawPhone - The mobile number to check
 * @returns {boolean}
 */
const isOtpBypassNumber = rawPhone => {
  if (!rawPhone) return false

  const normalized = normalizeMobileForMsg91(rawPhone)
  if (normalized.error || !normalized.value) {
    const fallbackDigits = normalizeMobileDigits(rawPhone)
    if (!fallbackDigits.error && fallbackDigits.value) {
      const tenDigits = fallbackDigits.value.slice(-10)
      return getBypassNumbers().includes(tenDigits)
    }
    return false
  }

  const { local } = normalized.value
  return getBypassNumbers().includes(local)
}

/**
 * Checks if an incoming Express request contains a mobile number matching the OTP bypass whitelist.
 * Inspects body and query parameters: phoneNumber, phone, mobile.
 *
 * @param {import('express').Request} req - The Express request object
 * @returns {boolean}
 */
const isOtpBypassRequest = req => {
  if (!req) return false

  const candidates = [
    req.body?.phoneNumber,
    req.body?.phone,
    req.body?.mobile,
    req.query?.phoneNumber,
    req.query?.phone,
    req.query?.mobile
  ]

  for (const candidate of candidates) {
    if (candidate && isOtpBypassNumber(candidate)) {
      return true
    }
  }

  return false
}

module.exports = {
  DEFAULT_BYPASS_NUMBERS,
  getBypassNumbers,
  isOtpBypassNumber,
  isOtpBypassRequest
}

