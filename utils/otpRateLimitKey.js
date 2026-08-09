const { normalizeMobileForMsg91 } = require('./msg91Otp.service')

const getUserOtpResendRateLimitKey = req => {
  const normalizedPhone = normalizeMobileForMsg91(
    req?.query?.phoneNumber ?? req?.body?.phoneNumber
  )

  if (normalizedPhone && normalizedPhone.value) {
    return `mobile:${normalizedPhone.value.international}`
  }

  return `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`
}

const getDriverOtpResendRateLimitKey = req => {
  const normalizedPhone = normalizeMobileForMsg91(
    req?.query?.phoneNumber ?? req?.body?.phoneNumber ?? req?.query?.phone ?? req?.body?.phone
  )

  if (normalizedPhone && normalizedPhone.value) {
    return `mobile:${normalizedPhone.value.international}`
  }

  return `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`
}

module.exports = {
  getUserOtpResendRateLimitKey,
  getDriverOtpResendRateLimitKey
}
