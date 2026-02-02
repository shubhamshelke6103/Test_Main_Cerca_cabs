const express = require('express')
const router = express.Router()
const {
  getWaitingIssues,
  getActiveChats,
  getResolvedIssues,
  getIssueById,
  getIssueMessages,
  resolveIssue,
  getSupportStats,
  getAllIssues
} = require('../../Controllers/Admin/support.controller')
const { authenticateAdmin } = require('../../utils/adminAuth')

// All routes require admin authentication
router.use(authenticateAdmin)

// Get all issues with filters
router.get('/issues', getAllIssues)

// Get waiting issues
router.get('/issues/waiting', getWaitingIssues)

// Get active chats for current admin
router.get('/issues/active', getActiveChats)

// Get resolved issues
router.get('/issues/resolved', getResolvedIssues)

// Get support statistics
router.get('/stats', getSupportStats)

// Get issue by ID
router.get('/issues/:issueId', getIssueById)

// Get messages for an issue
router.get('/issues/:issueId/messages', getIssueMessages)

// Resolve an issue
router.post('/issues/:issueId/resolve', resolveIssue)

module.exports = router

