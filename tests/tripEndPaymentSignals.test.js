'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { isPostRideRazorpay } = require('../utils/paymentOrchestrator/ridePaymentMode')

/** Mirror emitPaymentRequired (no DB deps) for unit testing. */
function emitPaymentRequiredForTest (io, ride, paymentPayload) {
  if (!io || !paymentPayload || !ride) return

  const rideRoom = `ride_${String(ride._id)}`
  const payload = {
    ...paymentPayload,
    ride: ride.toObject ? ride.toObject() : ride
  }

  io.to(rideRoom).emit('paymentRequired', payload)
  if (ride.userSocketId) {
    io.to(ride.userSocketId).emit('paymentRequired', payload)
  }
  if (ride.driverSocketId) {
    io.to(ride.driverSocketId).emit('paymentRequired', payload)
  }
}

describe('isPostRideRazorpay', () => {
  it('detects post-ride Pay Online booking', () => {
    assert.equal(
      isPostRideRazorpay({
        paymentMethod: 'RAZORPAY',
        razorpayPaymentId: null,
        walletAmountUsed: 0
      }),
      true
    )
  })

  it('returns false when razorpayPaymentId exists', () => {
    assert.equal(
      isPostRideRazorpay({
        paymentMethod: 'RAZORPAY',
        razorpayPaymentId: 'pay_abc',
        walletAmountUsed: 0
      }),
      false
    )
  })
})

describe('paymentRequired emission shape', () => {
  it('emits to ride room and rider/driver sockets when provided', () => {
    const emitted = []
    const io = {
      to: (room) => ({
        emit: (event, payload) => {
          emitted.push({ room, event, payload })
        }
      })
    }
    const ride = {
      _id: 'ride123',
      userSocketId: 'userSock',
      driverSocketId: 'driverSock',
      toObject: () => ({ _id: 'ride123', fare: 250 })
    }
    const paymentPayload = {
      rideId: 'ride123',
      amount: 250,
      paymentMethod: 'RAZORPAY',
      reason: 'ride_complete'
    }
    emitPaymentRequiredForTest(io, ride, paymentPayload)
    assert.equal(emitted.length, 3)
    assert.ok(emitted.some((e) => e.room === 'ride_ride123'))
    assert.ok(emitted.some((e) => e.room === 'userSock'))
    assert.ok(emitted.some((e) => e.room === 'driverSock'))
    const roomEmit = emitted.find((e) => e.room === 'ride_ride123')
    assert.equal(roomEmit.event, 'paymentRequired')
    assert.equal(roomEmit.payload.amount, 250)
    assert.ok(roomEmit.payload.ride)
  })
})
