const express = require('express')
const {
  listPaymentDisputes,
  getPaymentDisputeById,
  resolvePaymentDispute,
  getPaymentDisputeStats,
  triggerGatewayReconcile,
} = require('../../Controllers/Admin/paymentDispute.controller')

const router = express.Router()

router.get('/payment-disputes/stats', getPaymentDisputeStats)
router.post('/payment-disputes/reconcile-gateway', triggerGatewayReconcile)
router.get('/payment-disputes', listPaymentDisputes)
router.get('/payment-disputes/:id', getPaymentDisputeById)
router.patch('/payment-disputes/:id/resolve', resolvePaymentDispute)

module.exports = router
