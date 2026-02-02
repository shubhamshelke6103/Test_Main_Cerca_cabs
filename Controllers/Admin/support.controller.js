const SupportIssue = require('../../Models/support/supportIssue.model')
const SupportMessage = require('../../Models/support/supportMessage.model')
const SupportFeedback = require('../../Models/support/supportFeedback.model')
const User = require('../../Models/User/user.model')
const logger = require('../../utils/logger')

exports.getWaitingIssues = async (req, res) => {
  try {
    const issues = await SupportIssue.find({ status: 'WAITING_FOR_ADMIN' })
      .populate('userId', 'fullName email phoneNumber')
      .sort({ createdAt: -1 })
    res.json(issues)
  } catch (error) {
    logger.error('Error fetching waiting issues:', error)
    res.status(500).json({ message: 'Failed to fetch waiting issues', error: error.message })
  }
}

exports.getActiveChats = async (req, res) => {
  try {
    const issues = await SupportIssue.find({
      adminId: req.admin.id,
      status: 'CHAT_ACTIVE'
    })
      .populate('userId', 'fullName email phoneNumber')
      .sort({ updatedAt: -1 })
    res.json(issues)
  } catch (error) {
    logger.error('Error fetching active chats:', error)
    res.status(500).json({ message: 'Failed to fetch active chats', error: error.message })
  }
}

exports.getResolvedIssues = async (req, res) => {
  try {
    const issues = await SupportIssue.find({
      status: 'RESOLVED'
    })
      .populate('userId', 'fullName email phoneNumber')
      .populate('adminId', 'fullName email')
      .sort({ resolvedAt: -1 })
      .limit(100)
    res.json(issues)
  } catch (error) {
    logger.error('Error fetching resolved issues:', error)
    res.status(500).json({ message: 'Failed to fetch resolved issues', error: error.message })
  }
}

exports.getIssueById = async (req, res) => {
  try {
    const { issueId } = req.params
    const issue = await SupportIssue.findById(issueId)
      .populate('userId', 'fullName email phoneNumber')
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
    const { issueId } = req.params
    const messages = await SupportMessage.find({ issueId })
      .sort({ createdAt: 1 })

    res.json(messages)
  } catch (error) {
    logger.error('Error fetching issue messages:', error)
    res.status(500).json({ message: 'Failed to fetch messages', error: error.message })
  }
}

exports.resolveIssue = async (req, res) => {
  try {
    const { issueId } = req.params
    const adminId = req.admin.id

    const issue = await SupportIssue.findById(issueId)
    if (!issue) {
      return res.status(404).json({ message: 'Issue not found' })
    }

    if (issue.adminId?.toString() !== adminId) {
      return res.status(403).json({ message: 'You are not authorized to resolve this issue' })
    }

    issue.status = 'FEEDBACK_PENDING'
    issue.resolvedAt = new Date()
    await issue.save()

    // Create system message
    await SupportMessage.create({
      issueId,
      senderType: 'SYSTEM',
      message: 'Support chat has been resolved. Please provide your feedback.'
    })

    res.json({ message: 'Issue resolved successfully', issue })
  } catch (error) {
    logger.error('Error resolving issue:', error)
    res.status(500).json({ message: 'Failed to resolve issue', error: error.message })
  }
}

exports.getSupportStats = async (req, res) => {
  try {
    const waitingCount = await SupportIssue.countDocuments({ status: 'WAITING_FOR_ADMIN' })
    const activeCount = await SupportIssue.countDocuments({ status: 'CHAT_ACTIVE' })
    const resolvedCount = await SupportIssue.countDocuments({ status: 'RESOLVED' })
    const feedbackPendingCount = await SupportIssue.countDocuments({ status: 'FEEDBACK_PENDING' })
    
    const adminActiveChats = await SupportIssue.countDocuments({
      adminId: req.admin.id,
      status: 'CHAT_ACTIVE'
    })

    // Get average rating
    const feedbacks = await SupportFeedback.find({ rating: { $exists: true } })
    const avgRating = feedbacks.length > 0
      ? feedbacks.reduce((sum, f) => sum + (f.rating || 0), 0) / feedbacks.length
      : 0

    res.json({
      waiting: waitingCount,
      active: activeCount,
      resolved: resolvedCount,
      feedbackPending: feedbackPendingCount,
      adminActiveChats,
      averageRating: Math.round(avgRating * 10) / 10,
      totalIssues: waitingCount + activeCount + resolvedCount + feedbackPendingCount
    })
  } catch (error) {
    logger.error('Error fetching support stats:', error)
    res.status(500).json({ message: 'Failed to fetch support stats', error: error.message })
  }
}

exports.getAllIssues = async (req, res) => {
  try {
    const { status, issueType, page = 1, limit = 20 } = req.query
    const query = {}

    if (status) {
      query.status = status
    }
    if (issueType) {
      query.issueType = issueType
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const issues = await SupportIssue.find(query)
      .populate('userId', 'fullName email phoneNumber')
      .populate('adminId', 'fullName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))

    const total = await SupportIssue.countDocuments(query)

    res.json({
      issues,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    })
  } catch (error) {
    logger.error('Error fetching all issues:', error)
    res.status(500).json({ message: 'Failed to fetch issues', error: error.message })
  }
}
