const Notification = require('../../Models/User/notification.model.js')
const logger = require('../../utils/logger.js')

/**
 * GET /admin/notifications
 * Query: limit, skip, unreadOnly
 */
exports.listAdminNotifications = async (req, res) => {
  try {
    const recipientId = req.adminId
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100)
    const skip = parseInt(req.query.skip, 10) || 0
    const unreadOnly = req.query.unreadOnly === 'true'

    const query = {
      recipient: recipientId,
      recipientModel: 'Admin',
    }
    if (unreadOnly) {
      query.isRead = false
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({
        recipient: recipientId,
        recipientModel: 'Admin',
      }),
      Notification.countDocuments({
        recipient: recipientId,
        recipientModel: 'Admin',
        isRead: false,
      }),
    ])

    res.status(200).json({
      success: true,
      notifications,
      total,
      unreadCount,
      count: notifications.length,
    })
  } catch (error) {
    logger.error('listAdminNotifications:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load notifications',
    })
  }
}

/**
 * PATCH /admin/notifications/:id/read
 */
exports.markAdminNotificationRead = async (req, res) => {
  try {
    const { id } = req.params
    const notification = await Notification.findOneAndUpdate(
      {
        _id: id,
        recipient: req.adminId,
        recipientModel: 'Admin',
      },
      { isRead: true },
      { new: true }
    )

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      })
    }

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      notification,
    })
  } catch (error) {
    logger.error('markAdminNotificationRead:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update notification',
    })
  }
}

/**
 * PATCH /admin/notifications/read-all
 */
exports.markAllAdminNotificationsRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      {
        recipient: req.adminId,
        recipientModel: 'Admin',
        isRead: false,
      },
      { isRead: true }
    )

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
      modifiedCount: result.modifiedCount,
    })
  } catch (error) {
    logger.error('markAllAdminNotificationsRead:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark all as read',
    })
  }
}
