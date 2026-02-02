const SupportIssue = require('../../Models/support/supportIssue.model')
const SupportMessage = require('../../Models/support/supportMessage.model')
const SupportFeedback = require('../../Models/support/supportFeedback.model')
const logger = require('../../utils/logger')
const { getSocketIO } = require('../../utils/socket')

exports.getUserIssues = async (req, res) => {
  try {
    const { userId } = req.params

    // For now, allow access if userId matches (authentication can be added later)
    // In production, verify req.user.id === userId after adding auth middleware

    const issues = await SupportIssue.find({ userId })
      .populate('adminId', 'fullName email')
      .sort({ createdAt: -1 })

    res.json(issues)
  } catch (error) {
    logger.error('Error fetching user issues:', error)
    res.status(500).json({ message: 'Failed to fetch user issues', error: error.message })
  }
}

exports.getIssueById = async (req, res) => {
  try {
    const { issueId, userId } = req.params

    // For now, allow access if userId matches (authentication can be added later)
    // In production, verify req.user.id === userId after adding auth middleware

    const issue = await SupportIssue.findOne({ _id: issueId, userId })
      .populate('adminId', 'fullName email')

    if (!issue) {
      return res.status(404).json({ message: 'Issue not found' })
    }

    res.json(issue)
  } catch (error) {
    logger.error('Error fetching issue:', error)
    res.status(500).json({ message: 'Failed to fetch issue', error: error.message })
  }
}

exports.getIssueMessages = async (req, res) => {
  try {
    const { issueId, userId } = req.params

    // For now, allow access if userId matches (authentication can be added later)
    // In production, verify req.user.id === userId after adding auth middleware

    // Verify issue belongs to user
    const issue = await SupportIssue.findOne({ _id: issueId, userId })
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found' })
    }

    const messages = await SupportMessage.find({ issueId })
      .sort({ createdAt: 1 })

    res.json(messages)
  } catch (error) {
    logger.error('Error fetching issue messages:', error)
    res.status(500).json({ message: 'Failed to fetch messages', error: error.message })
  }
}

exports.createIssue = async (req, res) => {
  try {
    const { userId } = req.params
    const { issueType } = req.body

    // For now, allow access if userId matches (authentication can be added later)
    // In production, verify req.user.id === userId after adding auth middleware

    // Validate issue type
    const validTypes = ['RIDE', 'PAYMENT', 'ACCOUNT', 'GENERAL']
    if (!validTypes.includes(issueType)) {
      return res.status(400).json({ message: 'Invalid issue type' })
    }

    // Check for existing active issue
    const existingIssue = await SupportIssue.findOne({
      userId,
      status: {
        $in: ['WAITING_FOR_ADMIN', 'ADMIN_ASSIGNED', 'CHAT_ACTIVE', 'FEEDBACK_PENDING']
      }
    })

    if (existingIssue) {
      return res.status(400).json({
        message: 'You already have an active support chat',
        issueId: existingIssue._id
      })
    }

    const issue = await SupportIssue.create({
      userId,
      issueType: issueType || 'GENERAL'
    })

    logger.info(`Support issue created - issueId: ${issue._id}, userId: ${userId}, issueType: ${issueType}`)

    res.status(201).json(issue)
  } catch (error) {
    logger.error('Error creating issue:', error)
    res.status(500).json({ message: 'Failed to create issue', error: error.message })
  }
}

exports.submitFeedback = async (req, res) => {
  try {
    const { issueId, userId } = req.params
    const { rating, comment, resolved } = req.body

    // For now, allow access if userId matches (authentication can be added later)
    // In production, verify req.user.id === userId after adding auth middleware

    // Verify issue belongs to user
    const issue = await SupportIssue.findOne({ _id: issueId, userId })
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found' })
    }

    if (issue.status !== 'FEEDBACK_PENDING') {
      return res.status(400).json({ message: 'Issue is not in feedback pending status' })
    }

    // Validate rating
    if (rating !== undefined && (rating < 1 || rating > 10)) {
      return res.status(400).json({ message: 'Rating must be between 1 and 10' })
    }

    // Validate resolved status
    if (typeof resolved !== 'boolean') {
      return res.status(400).json({ message: 'Resolved status is required' })
    }

    // Check if feedback already exists
    const existingFeedback = await SupportFeedback.findOne({ issueId })
    if (existingFeedback) {
      return res.status(400).json({ message: 'Feedback already submitted for this issue' })
    }

    // Create feedback
    const feedback = await SupportFeedback.create({
      issueId,
      resolved,
      rating: rating || null,
      comment: comment || null
    })

    // Update issue status
    if (resolved) {
      issue.status = 'RESOLVED'
    } else {
      issue.status = 'ESCALATED'
      issue.escalated = true
    }
    issue.resolvedAt = new Date()
    await issue.save()

    // Emit status changed event for real-time updates
    try {
      const io = getSocketIO()
      io.to(`support_issue_${issueId}`).emit('support:status_changed', {
        issueId,
        status: issue.status,
        userId: issue.userId.toString(),
        adminId: issue.adminId?.toString()
      })
      io.to(`support_user_${issue.userId}`).emit('support:status_changed', {
        issueId,
        status: issue.status
      })
      if (issue.adminId) {
        io.to(`admin_${issue.adminId}`).emit('support:status_changed', {
          issueId,
          status: issue.status
        })
      }
      io.to('admin_support_online').emit('support:status_changed', {
        issueId,
        status: issue.status
      })

      // Emit stats update
      const SupportIssueModel = require('../../Models/support/supportIssue.model')
      const waitingCount = await SupportIssueModel.countDocuments({ status: 'WAITING_FOR_ADMIN' })
      const activeCount = await SupportIssueModel.countDocuments({ status: 'CHAT_ACTIVE' })
      const resolvedCount = await SupportIssueModel.countDocuments({ status: 'RESOLVED' })
      io.to('admin_support_online').emit('support:stats_updated', {
        stats: {
          waiting: waitingCount,
          active: activeCount,
          resolved: resolvedCount
        }
      })
    } catch (socketError) {
      logger.error('Error emitting status_changed event:', socketError)
      // Don't fail the request if socket emission fails
    }

    logger.info(`Feedback submitted - issueId: ${issueId}, rating: ${rating}, resolved: ${resolved}`)

    res.json({ message: 'Feedback submitted successfully', feedback, issue })
  } catch (error) {
    logger.error('Error submitting feedback:', error)
    res.status(500).json({ message: 'Failed to submit feedback', error: error.message })
  }
}

