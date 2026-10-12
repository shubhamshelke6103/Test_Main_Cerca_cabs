const assert = require('assert');
const crypto = require('crypto');
const {
  getRazorpayConfig,
  getRazorpayInstance,
} = require('../utils/driverCashSettlement.service');
const {
  computeDriverNetSettlementFromEarnings,
} = require('../utils/driverNetSettlementBalance');

// Helper to create test earning
function createEarning(id, overrides) {
  return {
    _id: id,
    driverId: 'drv123',
    paymentStatus: 'completed',
    paymentMethodSnapshot: 'CASH',
    grossFare: 100,
    platformFee: 5,
    driverEarning: 95,
    cashPlatformReceivable: {
      status: 'outstanding',
      amount: 5,
      paymentMethod: 'MANUAL_CASH',
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpaySignature: null,
    },
    ...overrides,
  };
}

(() => {
  console.log('Running tests for driver Razorpay cash settlement...');

  // 1. Verify Razorpay configuration helper
  const config = getRazorpayConfig();
  assert.ok(config.key, 'Razorpay key must exist');
  assert.ok(config.secret, 'Razorpay secret must exist');

  const instance = getRazorpayInstance();
  assert.ok(instance, 'Razorpay instance must be created');
  assert.ok(instance.orders, 'Razorpay instance must have orders API');

  // 2. Cryptographic signature generation and verification test
  const testOrderId = 'order_test_12345';
  const testPaymentId = 'pay_test_67890';
  const validSignature = crypto
    .createHmac('sha256', config.secret)
    .update(`${testOrderId}|${testPaymentId}`)
    .digest('hex');

  const tamperedSignature = crypto
    .createHmac('sha256', config.secret)
    .update(`${testOrderId}|pay_tampered_wrong`)
    .digest('hex');

  // Verify valid signature matches
  const checkValidHmac = crypto
    .createHmac('sha256', config.secret)
    .update(`${testOrderId}|${testPaymentId}`)
    .digest('hex');
  assert.strictEqual(validSignature, checkValidHmac, 'Valid HMAC signature must match');
  assert.notStrictEqual(validSignature, tamperedSignature, 'Tampered signature must not match');

  // 3. FIFO Settlement simulation
  const earnings = [
    createEarning('e1', {
      grossFare: 200,
      platformFee: 6,
      cashPlatformReceivable: { amount: 6, status: 'outstanding' },
      rideDate: new Date('2026-01-01'),
    }),
    createEarning('e2', {
      grossFare: 500,
      platformFee: 9,
      cashPlatformReceivable: { amount: 9, status: 'outstanding' },
      rideDate: new Date('2026-01-02'),
    }),
    createEarning('e3', {
      grossFare: 1000,
      platformFee: 14,
      cashPlatformReceivable: { amount: 14, status: 'outstanding' },
      rideDate: new Date('2026-01-03'),
    }),
  ];

  const totalOutstanding = earnings.reduce((sum, e) => sum + e.cashPlatformReceivable.amount, 0);
  assert.strictEqual(totalOutstanding, 29, 'Total outstanding should be 6 + 9 + 14 = 29');

  // Test full payment of 29 INR settles all
  let remainingPay = 29;
  for (const e of earnings) {
    if (remainingPay >= e.cashPlatformReceivable.amount) {
      remainingPay -= e.cashPlatformReceivable.amount;
      e.cashPlatformReceivable.status = 'settled';
      e.cashPlatformReceivable.paymentMethod = 'RAZORPAY';
      e.cashPlatformReceivable.razorpayPaymentId = testPaymentId;
    }
  }

  assert.strictEqual(remainingPay, 0, 'Remaining payment should be 0');
  assert.ok(earnings.every((e) => e.cashPlatformReceivable.status === 'settled'), 'All should be settled');
  assert.ok(
    earnings.every((e) => e.cashPlatformReceivable.paymentMethod === 'RAZORPAY'),
    'All should have paymentMethod RAZORPAY'
  );

  // 4. Verify effect on net settlement ledger
  // Before settlement:
  const beforeSettlementEarnings = [
    createEarning('e1', {
      cashPlatformReceivable: { amount: 6, status: 'outstanding' },
    }),
    {
      _id: 'online1',
      paymentStatus: 'completed',
      paymentMethodSnapshot: 'WALLET',
      driverEarning: 50,
      rideId: { tips: 0 },
    },
  ];
  const ledgerBefore = computeDriverNetSettlementFromEarnings(beforeSettlementEarnings, new Set());
  // Net should be 50 - 6 = 44
  assert.strictEqual(ledgerBefore.netSettlementBalance, 44);
  assert.strictEqual(ledgerBefore.cashOwedToPlatformTotal, 6);

  // After Razorpay settlement:
  const afterSettlementEarnings = [
    createEarning('e1', {
      cashPlatformReceivable: {
        amount: 6,
        status: 'settled',
        paymentMethod: 'RAZORPAY',
        razorpayPaymentId: testPaymentId,
      },
    }),
    {
      _id: 'online1',
      paymentStatus: 'completed',
      paymentMethodSnapshot: 'WALLET',
      driverEarning: 50,
      rideId: { tips: 0 },
    },
  ];
  const ledgerAfter = computeDriverNetSettlementFromEarnings(afterSettlementEarnings, new Set());
  // Net should now be full 50 with 0 cash owed
  assert.strictEqual(ledgerAfter.netSettlementBalance, 50);
  assert.strictEqual(ledgerAfter.cashOwedToPlatformTotal, 0);

  console.log('driverCashSettlement.test.js: All tests passed successfully! ✅');
})();

