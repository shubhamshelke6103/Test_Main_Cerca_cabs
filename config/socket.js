const { Server } = require('socket.io')
const { createAdapter } = require('@socket.io/redis-adapter')
const redis = require('../config/redis')

module.exports = server => {
  const io = new Server(server, {
    cors: {
      origin: '*'
    }
  })

  // Redis pub/sub
  const pubClient = redis
  const subClient = redis.duplicate()

  io.adapter(createAdapter(pubClient, subClient))

  require('./driver.socket')(io)
  require('./ride.socket')(io)

  return io
}
