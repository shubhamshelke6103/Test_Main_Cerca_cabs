const nodemailer = require('nodemailer')
const Admin = require('../Models/User/admin.model')
const Vendor = require('../Models/vendor/vendor.models')
const ExternalAlert = require('../Models/System/externalAlert.model')
const { createNotification } = require('./ride_booking_functions')
const logger = require('./logger')

const ALERT_MAX_RETRIES = 3

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const getProviderName = channel => {
  if (channel === 'email') return process.env.ALERT_EMAIL_PROVIDER || 'none'
  if (channel === 'sms') return process.env.ALERT_SMS_PROVIDER || 'none'
  return 'none'
}

const sendEmail = async ({ to, subject, message }) => {
  const provider = process.env.ALERT_EMAIL_PROVIDER || 'none'

  if (provider === 'sendgrid') {
    if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) {
      throw new Error('SENDGRID_API_KEY or SENDGRID_FROM_EMAIL is missing')
    }
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.SENDGRID_FROM_EMAIL },
        subject: subject || 'Cerca Alert',
        content: [{ type: 'text/plain', value: message }]
      })
    })
    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`SendGrid failed: ${response.status} ${responseText}`)
    }
    return { provider: 'sendgrid', providerResponseCode: response.status }
  }

  if (provider === 'nodemailer') {
    const host = process.env.SMTP_HOST
    const port = parseInt(process.env.SMTP_PORT, 10)
    const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true'
    const user = process.env.SMTP_USER
    const pass = process.env.SMTP_PASS
    const from = process.env.SMTP_FROM_EMAIL

    if (!host || !port || Number.isNaN(port) || !user || !pass || !from) {
      throw new Error('SMTP credentials are missing or incomplete')
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass }
    })

    const info = await transporter.sendMail({
      from,
      to,
      subject: subject || 'Cerca Alert',
      text: message
    })

    return { provider: 'nodemailer', providerResponseCode: info.messageId || 'sent' }
  }

  if (provider === 'webhook') {
    if (!process.env.ALERT_EMAIL_WEBHOOK_URL) {
      throw new Error('ALERT_EMAIL_WEBHOOK_URL is missing')
    }
    const response = await fetch(process.env.ALERT_EMAIL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, message })
    })
    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Email webhook failed: ${response.status} ${responseText}`)
    }
    return { provider: 'webhook', providerResponseCode: response.status }
  }

  return { provider: 'none', skipped: true, reason: 'email_provider_not_configured' }
}

const sendSms = async ({ to, message }) => {
  const provider = process.env.ALERT_SMS_PROVIDER || 'none'

  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    const from = process.env.TWILIO_FROM_NUMBER
    if (!sid || !token || !from) {
      throw new Error('Twilio credentials are missing')
    }
    const body = new URLSearchParams({ To: to, From: from, Body: message })
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      }
    )
    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Twilio failed: ${response.status} ${responseText}`)
    }
    return { provider: 'twilio', providerResponseCode: response.status }
  }

  if (provider === 'webhook') {
    if (!process.env.ALERT_SMS_WEBHOOK_URL) {
      throw new Error('ALERT_SMS_WEBHOOK_URL is missing')
    }
    const response = await fetch(process.env.ALERT_SMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message })
    })
    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`SMS webhook failed: ${response.status} ${responseText}`)
    }
    return { provider: 'webhook', providerResponseCode: response.status }
  }

  return { provider: 'none', skipped: true, reason: 'sms_provider_not_configured' }
}

const dispatchExternalAlert = async payload => {
  const { channel, to, subject, message } = payload
  if (!to) return { channel, status: 'skipped', reason: 'missing_recipient' }
  const provider = getProviderName(channel)
  const alertRecord = await ExternalAlert.create({
    channel,
    to,
    subject: subject || null,
    message,
    provider,
    status: 'queued',
    metadata: payload.metadata || {}
  })

  for (let attempt = 1; attempt <= ALERT_MAX_RETRIES; attempt++) {
    try {
      const dispatchResult =
        channel === 'email'
          ? await sendEmail({ to, subject, message })
          : await sendSms({ to, message })

      if (dispatchResult.skipped) {
        await ExternalAlert.findByIdAndUpdate(alertRecord._id, {
          $set: {
            status: 'skipped',
            attemptCount: attempt,
            lastAttemptAt: new Date(),
            lastError: dispatchResult.reason || null,
            provider: dispatchResult.provider || provider
          }
        })
        return { channel, status: 'skipped', reason: dispatchResult.reason }
      }

      await ExternalAlert.findByIdAndUpdate(alertRecord._id, {
        $set: {
          status: 'delivered',
          attemptCount: attempt,
          lastAttemptAt: new Date(),
          lastError: null,
          provider: dispatchResult.provider || provider
        }
      })
      return { channel, status: 'delivered', attempts: attempt }
    } catch (error) {
      const isFinalAttempt = attempt === ALERT_MAX_RETRIES
      await ExternalAlert.findByIdAndUpdate(alertRecord._id, {
        $set: {
          status: isFinalAttempt ? 'failed' : 'queued',
          attemptCount: attempt,
          lastAttemptAt: new Date(),
          lastError: error.message
        }
      })

      logger.error(
        `External ${channel.toUpperCase()} alert attempt ${attempt} failed for ${to}: ${error.message}`
      )

      if (isFinalAttempt) {
        return { channel, status: 'failed', reason: error.message, attempts: attempt }
      }
      await sleep(500 * Math.pow(2, attempt - 1))
    }
  }

  return { channel, status: 'failed', reason: 'unknown_dispatch_failure' }
}

const notifyAdmins = async ({ title, message, type, data }) => {
  const admins = await Admin.find({ isActive: true }).select(
    'fullName email phoneNumber'
  )

  const results = []
  for (const admin of admins) {
    await createNotification({
      recipientId: admin._id,
      recipientModel: 'Admin',
      title,
      message,
      type,
      data
    })

    results.push(
      await dispatchExternalAlert({
        channel: 'email',
        to: admin.email,
        subject: title,
        message
      })
    )

    results.push(
      await dispatchExternalAlert({
        channel: 'sms',
        to: admin.phoneNumber,
        message
      })
    )
  }

  return results
}

const notifyVendor = async (vendorId, { title, message, type, data }) => {
  if (!vendorId) return []

  const vendor = await Vendor.findById(vendorId).select('email phone')
  if (!vendor) return []

  await createNotification({
    recipientId: vendor._id,
    recipientModel: 'Vendor',
    title,
    message,
    type,
    data
  })

  return [
    await dispatchExternalAlert({
      channel: 'email',
      to: vendor.email,
      subject: title,
      message
    }),
    await dispatchExternalAlert({
      channel: 'sms',
      to: vendor.phone,
      message
    })
  ]
}

module.exports = {
  dispatchExternalAlert,
  notifyAdmins,
  notifyVendor
}
