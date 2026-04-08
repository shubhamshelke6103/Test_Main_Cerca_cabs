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

const escapeHtml = text =>
  String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const buildEmailHtml = ({ subject, message }) => {
  const brandName = process.env.EMAIL_BRAND_NAME || 'Cerca Cars'
  const logoUrlRaw = process.env.SMTP_EMAIL_LOGO_URL || ''
  const emailBaseUrl = String(process.env.EMAIL_PUBLIC_URL || '').replace(/\/$/, '')
  const logoPath = String(process.env.EMAIL_LOGO_PATH || '').replace(/^\//, '')
  const logoUrlFallback = emailBaseUrl && logoPath ? `${emailBaseUrl}/${logoPath}` : ''
  const logoUrl = logoUrlRaw || logoUrlFallback || ''
  const escapedMessage = escapeHtml(message).replace(/\n/g, '<br />')
  const otpMatch = message ? message.match(/\b(\d{4,8})\b/) : null
  const otpCode = otpMatch ? otpMatch[1] : null

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject || brandName)} | ${escapeHtml(brandName)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6fb;font-family:Arial, 'Helvetica Neue', Helvetica, sans-serif;color:#111827;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 24px 60px rgba(15,23,42,0.1);">
          <tr>
            <td style="background:#111827;padding:28px 24px;text-align:center;">
              ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(brandName)} logo" width="140" style="display:block;margin:0 auto;" />` : `<span style="font-size:26px;font-weight:700;color:#ffffff;letter-spacing:0.06em;">${escapeHtml(brandName)}</span>`}
            </td>
          </tr>
          <tr>
            <td style="padding:36px 36px 24px;">
              <h1 style="margin:0 0 16px;font-size:26px;line-height:1.15;color:#111827;">Password Reset OTP</h1>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.8;color:#475569;">
                Use the code below to reset your vendor account password. This code expires in 10 minutes for your security.
              </p>
              ${otpCode ? `<div style="margin:0 0 24px;padding:22px 18px;border:1px solid #e2e8f0;border-radius:16px;background:#f8fafc;display:inline-flex;align-items:center;justify-content:center;min-width:280px;">
                  <span style="font-size:32px;letter-spacing:0.15em;font-weight:700;color:#111827;">${escapeHtml(otpCode)}</span>
                </div>` : ''}
              <div style="padding:24px 22px;border-radius:20px;background:#f3f6ff;border:1px solid #dbeafe;">
                <p style="margin:0;font-size:15px;line-height:1.75;color:#334155;">
                  <strong style="color:#0f172a;">One-time password (OTP):</strong><br />
                  ${escapedMessage}
                </p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 32px;">
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:20px;">
                <p style="margin:0;font-size:14px;line-height:1.7;color:#475569;">
                  If you did not request this password reset, please ignore this email or contact our support team immediately.
                </p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background:#eef2ff;padding:20px 36px;text-align:center;font-size:13px;color:#64748b;">
              © ${new Date().getFullYear()} ${escapeHtml(brandName)}. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
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

    const html = buildEmailHtml({ subject: subject || 'Cerca Alert', message })
    const info = await transporter.sendMail({
      from,
      to,
      subject: subject || 'Cerca Alert',
      text: message,
      html
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

/**
 * Deliver an existing ExternalAlert row (retries, status updates).
 * Used by synchronous dispatch and by the BullMQ worker.
 */
const deliverExternalAlertRecord = async alertRecord => {
  const channel = alertRecord.channel
  const to = alertRecord.to
  const subject = alertRecord.subject
  const message = alertRecord.message
  if (!to) return { channel, status: 'skipped', reason: 'missing_recipient' }
  const provider = getProviderName(channel)

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

const deliverExternalAlertById = async alertId => {
  const alertRecord = await ExternalAlert.findById(alertId)
  if (!alertRecord) {
    logger.error(`deliverExternalAlertById: ExternalAlert not found ${alertId}`)
    return { status: 'missing' }
  }
  return deliverExternalAlertRecord(alertRecord)
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
  return deliverExternalAlertRecord(alertRecord)
}

/**
 * Create ExternalAlert and enqueue email delivery (BullMQ).
 * Falls back to inline delivery if Redis/queue is unavailable.
 */
const queueExternalAlertEmail = async payload => {
  const { channel, to, subject, message } = payload
  if (channel !== 'email') {
    return dispatchExternalAlert(payload)
  }
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

  try {
    const { externalAlertEmailQueue } = require('../src/queues/externalAlertEmail.queue')
    await externalAlertEmailQueue.add(
      'deliver',
      { alertId: String(alertRecord._id) },
      { removeOnComplete: 200, removeOnFail: 100 }
    )
    return { channel, status: 'queued', alertId: alertRecord._id }
  } catch (err) {
    logger.warn(
      `externalAlertEmail queue unavailable, delivering inline: ${err.message}`
    )
    const fresh = await ExternalAlert.findById(alertRecord._id)
    if (!fresh) {
      return { channel, status: 'failed', reason: 'alert_record_missing' }
    }
    return deliverExternalAlertRecord(fresh)
  }
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
  queueExternalAlertEmail,
  deliverExternalAlertById,
  deliverExternalAlertRecord,
  notifyAdmins,
  notifyVendor
}
