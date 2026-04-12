const assert = require('assert')
const {
  clampRideLimit,
  clampRidePage,
  parseRideSort,
  sortRideWiseRows,
  paginateRideRows,
  normalizeLicensePlateFilter,
  dateRangeWarning,
  MAX_RIDE_LIMIT,
  DEFAULT_RIDE_LIMIT
} = require('../utils/vendorEarningsReport.util')

;(() => {
  assert.strictEqual(clampRideLimit(undefined), DEFAULT_RIDE_LIMIT)
  assert.strictEqual(clampRideLimit('0'), DEFAULT_RIDE_LIMIT)
  assert.strictEqual(clampRideLimit(50), 50)
  assert.strictEqual(clampRideLimit(9999), MAX_RIDE_LIMIT)

  assert.strictEqual(clampRidePage(undefined), 1)
  assert.strictEqual(clampRidePage('3'), 3)

  assert.deepStrictEqual(parseRideSort('grossRevenue', 'asc'), {
    rideSort: 'grossRevenue',
    rideOrder: 'asc'
  })
  assert.deepStrictEqual(parseRideSort('invalid', 'DESC'), {
    rideSort: 'rideDate',
    rideOrder: 'desc'
  })

  const rows = [
    { rideDate: new Date('2024-01-02'), grossRevenue: 100, driverEarning: 10, vendorProfit: 5 },
    { rideDate: new Date('2024-01-01'), grossRevenue: 200, driverEarning: 20, vendorProfit: 8 }
  ]
  const byDateDesc = sortRideWiseRows(rows, 'rideDate', 'desc')
  assert.strictEqual(byDateDesc[0].grossRevenue, 100)
  const byGrossAsc = sortRideWiseRows(rows, 'grossRevenue', 'asc')
  assert.strictEqual(byGrossAsc[0].grossRevenue, 100)

  const paged = paginateRideRows(sortRideWiseRows(rows, 'rideDate', 'desc'), 1, 1)
  assert.strictEqual(paged.total, 2)
  assert.strictEqual(paged.slice.length, 1)

  assert.strictEqual(normalizeLicensePlateFilter(' ab 12 '), 'AB12')
  assert.strictEqual(normalizeLicensePlateFilter('   '), null)

  const warn = dateRangeWarning('2024-01-01', '2025-06-01')
  assert.ok(warn && warn.includes('366'))
})()
