const AppError = require('./errors/AppError')
const { normalizeMobileDigits } = require('./contactValidation')

const MSG91_BASE_URL =
  process.env.MSG91_BASE_URL || 'https://control.msg91.com/api/v5/otp'
const MSG91_TEMPLATE_ID =
  process.env.MSG91_TEMPLATE_ID || ''
const MSG91_AUTHKEY =
  process.env.MSG91_AUTHKEY || process.env.MSG91_AUTH_KEY || ''
const MSG91_REQUEST_TIMEOUT_MS = Number(
  process.env.MSG91_REQUEST_TIMEOUT_MS || 15000
)
const MSG91_DEFAULT_RETRY_TYPE = process.env.MSG91_DEFAULT_RETRY_TYPE || 'text'

const ensureFetch = () => {
  const fetchFn = typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : null

  if (!fetchFn) {
    throw new AppError('Fetch API is not available in this runtime', 500, {
      code: 'FETCH_NOT_AVAILABLE'
    })
  }

  return fetchFn
}

const normalizeMobileForMsg91 = rawPhone => {
  const normalized = normalizeMobileDigits(rawPhone)

  if (normalized.error || !normalized.value) {
    return normalized
  }

  let digits = normalized.value

  if (digits.length === 10) {
    return {
      value: {
        local: digits,
        international: `91${digits}`
      },
      error: null
    }
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1)
    if (digits.length === 10) {
      return {
        value: {
          local: digits,
          international: `91${digits}`
        },
        error: null
      }
    }
  }

  if (digits.length === 12 && digits.startsWith('91')) {
    return {
      value: {
        local: digits.slice(2),
        international: digits
      },
      error: null
    }
  }

  return {
    value: null,
    error: 'Please enter a valid 10-digit mobile number'
  }
}

const buildMsg91Url = (segment = '', params = {}) => {
  const normalizedBase = MSG91_BASE_URL.replace(/\/+$/, '')
  const url = segment
    ? new URL(segment.replace(/^\/+/, ''), `${normalizedBase}/`)
    : new URL(normalizedBase)

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value))
    }
  })

  return url
}

const parseMsg91Response = async response => {
  const rawText = await response.text()

  if (!rawText) {
    return {}
  }

  try {
    return JSON.parse(rawText)
  } catch {
    return { raw: rawText }
  }
}

const mapVerifyOtpError = (payload = {}, fallbackStatus = 400) => {
  const message = String(
    payload.message || payload.error || payload.raw || ''
  ).trim().toLowerCase()

  if (
    message.includes('incorrect') ||
    message.includes('invalid otp') ||
    message.includes('wrong otp')
  ) {
    return new AppError('The OTP you entered is incorrect.', 400, {
      code: 'INVALID_OTP',
      details: {
        response: payload
      }
    })
  }

  if (
    message.includes('expired') ||
    message.includes('timeout') ||
    message.includes('timed out')
  ) {
    return new AppError('OTP has expired. Please request a new one.', 400, {
      code: 'OTP_EXPIRED',
      details: {
        response: payload
      }
    })
  }

  return new AppError(
    payload.message || payload.error || 'OTP verification failed',
    fallbackStatus,
    {
      code: payload.code || 'OTP_VERIFICATION_FAILED',
      details: {
        response: payload
      }
    }
  )
}

const requestMsg91 = async (url, options = {}, operation = 'MSG91 request') => {
  const fetch = ensureFetch()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MSG91_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })

    const payload = await parseMsg91Response(response)
    const operationKey = String(operation || '').toLowerCase()
    const isVerifyOperation = operationKey.includes('verify otp')
    const payloadType = String(payload.type || '').trim().toLowerCase()
    const verifySucceeded = payloadType === 'success'

    if (isVerifyOperation && !verifySucceeded) {
      throw mapVerifyOtpError(payload, response.status >= 400 ? response.status : 400)
    }

    if (!response.ok) {
      throw new AppError(
        payload.message ||
          payload.error ||
          `${operation} failed with status ${response.status}`,
        response.status >= 400 && response.status < 600 ? response.status : 502,
        {
          code: 'MSG91_REQUEST_FAILED',
          details: {
            operation,
            response: payload
          }
        }
      )
    }

    if (isVerifyOperation && !verifySucceeded) {
      throw mapVerifyOtpError(payload, 400)
    }

    return payload
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new AppError(`${operation} timed out`, 504, {
        code: 'MSG91_TIMEOUT',
        details: { operation }
      })
    }

    if (error instanceof AppError) {
      throw error
    }

    throw new AppError(`Unable to complete ${operation}`, 502, {
      code: 'MSG91_UNAVAILABLE',
      details: {
        operation,
        reason: error.message
      }
    })
  } finally {
    clearTimeout(timeout)
  }
}

const assertMsg91Configured = () => {
  if (!MSG91_AUTHKEY) {
    throw new AppError('MSG91 auth key is not configured', 500, {
      code: 'MSG91_NOT_CONFIGURED'
    })
  }
}

const sendLoginOtp = async mobile => {
  assertMsg91Configured()

  const url = buildMsg91Url('', {
    template_id: MSG91_TEMPLATE_ID,
    mobile,
    authkey: MSG91_AUTHKEY
  })

  return requestMsg91(url, { method: 'POST' }, 'Send OTP')
}

const resendLoginOtp = async mobile => {
  assertMsg91Configured()

  const url = buildMsg91Url('retry', {
    authkey: MSG91_AUTHKEY,
    retrytype: MSG91_DEFAULT_RETRY_TYPE,
    mobile
  })

  return requestMsg91(url, { method: 'GET' }, 'Resend OTP')
}

const verifyLoginOtp = async ({ mobile, otp }) => {
  assertMsg91Configured()

  const url = buildMsg91Url('verify', {
    otp,
    mobile
  })

  return requestMsg91(
    url,
    {
      method: 'GET',
      headers: {
        authkey: MSG91_AUTHKEY
      }
    },
    'Verify OTP'
  )
}

module.exports = {
  MSG91_BASE_URL,
  MSG91_TEMPLATE_ID,
  MSG91_AUTHKEY,
  normalizeMobileForMsg91,
  sendLoginOtp,
  resendLoginOtp,
  verifyLoginOtp
}
