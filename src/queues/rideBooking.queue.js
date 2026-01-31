// src/queues/rideBooking.queue.js
const { Queue } = require('bullmq')

const rideBookingQueue = new Queue('{ride-booking}', {
  connection: redis,
})

module.exports = {
  QUEUE_NAME,
  rideBookingQueue,
}
