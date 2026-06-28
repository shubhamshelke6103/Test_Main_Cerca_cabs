const express = require('express')
const path = require('path')
const { deleteAuthenticatedUser } = require('../Controllers/User/user.controller.js')

const router = express.Router()

router.get('/delete-account.html', (req, res) => {
  return res.sendFile(
    path.join(process.cwd(), 'utils', 'account_deletion', 'delete-account.html')
  )
})

router.get('/delete-account.css', (req, res) => {
  return res.sendFile(
    path.join(process.cwd(), 'utils', 'account_deletion', 'delete-account.css')
  )
})

router.get('/delete-account.js', (req, res) => {
  return res.sendFile(
    path.join(process.cwd(), 'utils', 'account_deletion', 'delete-account.js')
  )
})

router.post('/delete-account.html', deleteAuthenticatedUser)

module.exports = router
