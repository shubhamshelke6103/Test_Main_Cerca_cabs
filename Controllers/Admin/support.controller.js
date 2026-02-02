const SupportIssue = require('../../Models/support/supportIssue.model')

exports.getWaitingIssues = async (req, res) => {
  const issues = await SupportIssue.find({ status: 'WAITING_FOR_ADMIN' })
  res.json(issues)
}

exports.getActiveChats = async (req, res) => {
  const issues = await SupportIssue.find({
    adminId: req.admin.id,
    status: 'CHAT_ACTIVE'
  })
  res.json(issues)
}

exports.getResolvedIssues = async (req, res) => {
  const issues = await SupportIssue.find({
    status: 'RESOLVED'
  }).sort({ resolvedAt: -1 })
  res.json(issues)
}
