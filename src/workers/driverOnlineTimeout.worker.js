const cron = require('node-cron')

const logger = require('../../utils/logger')
const socketUtils = require('../../utils/socket')
const {
  autoStopExpiredDriverSessions
} = require('../../utils/driverSession.service')

function initDriverOnlineTimeoutWorker () {
  logger.info('Initializing Driver Online Timeout Worker...')

  const io = socketUtils.getSocketIO()
  if (!io) {
    throw new Error('Socket.IO instance required for driver online timeout worker')
  }

  const maxOnlineMinutes = parseInt(
    process.env.DRIVER_MAX_ONLINE_MINUTES || '300',
    10
  )
  const checkIntervalMinutes = parseInt(
    process.env.DRIVER_ONLINE_TIMEOUT_CHECK_INTERVAL_MINUTES || '1',
    10
  )

  const cronExpression = `*/${Math.max(1, checkIntervalMinutes)} * * * *`

  cron.schedule(cronExpression, async () => {
    try {
      const result = await autoStopExpiredDriverSessions({
        maxOnlineMinutes
      })

      if (!result.stoppedDrivers.length) {
        return
      }

      logger.info(
        `Driver online timeout worker set ${result.stoppedDrivers.length} driver(s) offline after ${maxOnlineMinutes} minutes`
      )

      for (const driver of result.stoppedDrivers) {
        if (driver.socketId) {
          io.to(driver.socketId).emit('driverStatusUpdate', {
            driverId: driver._id,
            isOnline: false,
            isActive: driver.isActive,
            isBusy: driver.isBusy,
            reason: 'AUTO_TIMEOUT',
            message: `You have been set offline automatically after ${maxOnlineMinutes / 60} hours online`
          })
        }

        io.to('admin').emit('driverStatusChanged', {
          driverId: driver._id,
          isActive: driver.isActive,
          isOnline: false,
          reason: 'AUTO_TIMEOUT'
        })
      }
    } catch (error) {
      logger.error('Error in driver online timeout worker:', error)
    }
  })

  logger.info(
    `Driver Online Timeout Worker initialized - max online ${maxOnlineMinutes} minutes, check every ${checkIntervalMinutes} minute(s)`
  )
}

module.exports = initDriverOnlineTimeoutWorker
