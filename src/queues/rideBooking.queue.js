// src/queues/rideBooking.queue.js
const { Queue } = require('bullmq')
const redis = require('../../config/redis')

const QUEUE_NAME = '{ride-booking}'

const rideBookingQueue = new Queue(QUEUE_NAME, {
  connection: redis,
})

module.exports = {
  QUEUE_NAME,
  rideBookingQueue,
}
