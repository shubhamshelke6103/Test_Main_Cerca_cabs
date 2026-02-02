const express = require('express')
const router = express.Router()
const {
  getUserIssues,
  getIssueById,
  getIssueMessages,
  createIssue,
  submitFeedback
} = require('../../Controllers/User/support.controller')

// Get user's support issues
router.get('/:userId/support/issues', getUserIssues)

// Get issue by ID
router.get('/:userId/support/issues/:issueId', getIssueById)

// Get messages for an issue
router.get('/:userId/support/issues/:issueId/messages', getIssueMessages)

// Create new support issue
router.post('/:userId/support/issues', createIssue)

// Submit feedback for resolved issue
router.post('/:userId/support/issues/:issueId/feedback', submitFeedback)

module.exports = router

