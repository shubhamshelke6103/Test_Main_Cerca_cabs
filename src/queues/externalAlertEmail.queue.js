const { Queue } = require('bullmq')
const { redis } = require('../../config/redis')

const QUEUE_NAME = '{external-alert-email}'

const externalAlertEmailQueue = new Queue(QUEUE_NAME, {
  connection: redis
})

module.exports = {
  QUEUE_NAME,
  externalAlertEmailQueue
}
