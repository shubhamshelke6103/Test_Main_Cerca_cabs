'use strict'

const User = require('../../Models/User/user.model')
const Driver = require('../../Models/Driver/driver.model')
const logger = require('../../utils/logger')
const { sendPushNotification } = require('../../firebase.notify')

const MAX_TOKENS_PER_REQUEST = 100

/** Mask all but last 6 chars of a token for log lines. */
const maskToken = token => {
  if (typeof token !== 'string' || token.length <= 6) return '***'
  return `***${token.slice(-6)}`
}

/**
 * POST /admin/test/fcm
 * Body:
 *   {
 *     mode: 'userId' | 'driverId' | 'tokens',
 *     userId?: string,
 *     driverId?: string,
 *     tokens?: string[],          // up to MAX_TOKENS_PER_REQUEST
 *     title: string,
 *     body: string,
 *     data?: Record<string, any>, // values coerced to string by firebase.notify
 *     dataOnly?: boolean,         // omit notification block (data-only push)
 *     androidChannelId?: string,
 *   }
 *
 * Returns the structured response from `sendPushNotification` plus
 * a small audit summary. Does NOT persist a Notification document — this
 * endpoint is for debugging and should not pollute user notification history.
 */
exports.sendTestFcm = async (req, res) => {
  const adminId = req.adminId
  const adminEmail = req.admin?.email || 'unknown'

  try {
    const {
      mode,
      userId,
      driverId,
      tokens: rawTokens,
      title,
      body,
      data = {},
      dataOnly = false,
      androidChannelId,
    } = req.body || {}

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        success: false,
        error: 'title is required',
        code: 'MISSING_TITLE',
      })
    }
    if (typeof body !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'body is required (use empty string if no body desired)',
        code: 'MISSING_BODY',
      })
    }

    let tokens = []
    let resolvedFrom = mode

    if (mode === 'userId') {
      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'userId is required when mode=userId',
          code: 'MISSING_USER_ID',
        })
      }
      const user = await User.findById(userId).select('+fcmToken')
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
          code: 'USER_NOT_FOUND',
        })
      }
      if (!user.fcmToken) {
        return res.status(400).json({
          success: false,
          error: 'User has no FCM token registered',
          code: 'NO_FCM_TOKEN',
        })
      }
      tokens = [user.fcmToken]
    } else if (mode === 'driverId') {
      if (!driverId) {
        return res.status(400).json({
          success: false,
          error: 'driverId is required when mode=driverId',
          code: 'MISSING_DRIVER_ID',
        })
      }
      const driver = await Driver.findById(driverId).select('+fcmToken')
      if (!driver) {
        return res.status(404).json({
          success: false,
          error: 'Driver not found',
          code: 'DRIVER_NOT_FOUND',
        })
      }
      if (!driver.fcmToken) {
        return res.status(400).json({
          success: false,
          error: 'Driver has no FCM token registered',
          code: 'NO_FCM_TOKEN',
        })
      }
      tokens = [driver.fcmToken]
    } else if (mode === 'tokens') {
      if (!Array.isArray(rawTokens) || rawTokens.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'tokens[] is required when mode=tokens',
          code: 'MISSING_TOKENS',
        })
      }
      tokens = rawTokens
        .map(t => (typeof t === 'string' ? t.trim() : ''))
        .filter(Boolean)
      if (tokens.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'tokens[] contained no valid strings',
          code: 'INVALID_TOKENS',
        })
      }
      if (tokens.length > MAX_TOKENS_PER_REQUEST) {
        return res.status(400).json({
          success: false,
          error: `tokens[] capped at ${MAX_TOKENS_PER_REQUEST} entries`,
          code: 'TOO_MANY_TOKENS',
        })
      }
    } else {
      return res.status(400).json({
        success: false,
        error: "mode must be one of 'userId' | 'driverId' | 'tokens'",
        code: 'INVALID_MODE',
      })
    }

    logger.info(
      `[admin/test/fcm] adminId=${adminId} email=${adminEmail} mode=${resolvedFrom} ` +
        `tokenCount=${tokens.length} dataOnly=${dataOnly} ` +
        `tokens=[${tokens.map(maskToken).join(',')}]`
    )

    const sendArgs = {
      title,
      body,
      data: data || {},
      dataOnly: Boolean(dataOnly),
    }
    if (androidChannelId) sendArgs.androidChannelId = androidChannelId
    if (tokens.length === 1) {
      sendArgs.token = tokens[0]
    } else {
      sendArgs.tokens = tokens
    }

    const result = await sendPushNotification(sendArgs)

    // Sanitize FCM responses for client (mask tokens, summarize errors).
    let sanitizedResponses
    if (Array.isArray(result.responses)) {
      sanitizedResponses = result.responses.map((resp, idx) => ({
        index: idx,
        token: maskToken(tokens[idx]),
        success: Boolean(resp.success),
        messageId: resp.messageId || null,
        errorCode: resp.error?.code || null,
        errorMessage: resp.error?.message || null,
      }))
    }

    return res.status(result.success ? 200 : 502).json({
      success: result.success,
      mode: resolvedFrom,
      tokenCount: tokens.length,
      dispatch: {
        mode: result.mode || (tokens.length > 1 ? 'multicast' : 'single'),
        skipped: Boolean(result.skipped),
        reason: result.reason || null,
        successCount:
          typeof result.successCount === 'number'
            ? result.successCount
            : result.success
              ? 1
              : 0,
        failureCount:
          typeof result.failureCount === 'number'
            ? result.failureCount
            : result.success
              ? 0
              : 1,
        messageId: result.messageId || null,
        error: result.error || null,
      },
      responses: sanitizedResponses,
    })
  } catch (err) {
    logger.error(`[admin/test/fcm] adminId=${adminId} error: ${err.message}`)
    return res.status(500).json({
      success: false,
      error: err.message,
      code: 'INTERNAL_ERROR',
    })
  }
}
