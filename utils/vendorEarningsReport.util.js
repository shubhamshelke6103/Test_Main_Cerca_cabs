/**
 * Shared helpers for vendor earnings report pagination, sorting, and export limits.
 */

const DEFAULT_RIDE_LIMIT = 100
const MAX_RIDE_LIMIT = 500
const MAX_DATE_RANGE_MS = 366 * 24 * 60 * 60 * 1000
const MAX_CSV_RIDE_ROWS = 5000

const ALLOWED_RIDE_SORT = new Set(['rideDate', 'grossRevenue', 'driverEarning', 'vendorProfit'])

function clampRideLimit (raw) {
  const n = parseInt(String(raw ?? ''), 10)
  if (Number.isNaN(n) || n < 1) return DEFAULT_RIDE_LIMIT
  return Math.min(n, MAX_RIDE_LIMIT)
}

function clampRidePage (raw) {
  const n = parseInt(String(raw ?? ''), 10)
  if (Number.isNaN(n) || n < 1) return 1
  return n
}

function parseRideSort (sort, order) {
  const s = typeof sort === 'string' && ALLOWED_RIDE_SORT.has(sort) ? sort : 'rideDate'
  const o = String(order || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
  return { rideSort: s, rideOrder: o }
}

function sortRideWiseRows (rows, rideSort, rideOrder) {
  const mult = rideOrder === 'asc' ? 1 : -1
  const copy = [...rows]
  copy.sort((a, b) => {
    let va
    let vb
    if (rideSort === 'rideDate') {
      va = a.rideDate ? new Date(a.rideDate).getTime() : 0
      vb = b.rideDate ? new Date(b.rideDate).getTime() : 0
    } else {
      va = Number(a[rideSort]) || 0
      vb = Number(b[rideSort]) || 0
    }
    if (va < vb) return -1 * mult
    if (va > vb) return 1 * mult
    return 0
  })
  return copy
}

function paginateRideRows (sortedRows, ridePage, rideLimit) {
  const total = sortedRows.length
  const start = (ridePage - 1) * rideLimit
  const slice = sortedRows.slice(start, start + rideLimit)
  return { slice, total }
}

function normalizeLicensePlateFilter (raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/\s+/g, '').toUpperCase()
  return s.length ? s : null
}

function dateRangeWarning (startDate, endDate) {
  if (!startDate || !endDate) return null
  const a = new Date(startDate).getTime()
  const b = new Date(endDate).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  if (b - a > MAX_DATE_RANGE_MS) {
    return 'Date range exceeds 366 days; consider narrowing filters for faster loads.'
  }
  return null
}

function escapeCsvCell (value) {
  const s = String(value ?? '')
  return `"${s.replace(/"/g, '""')}"`
}

function buildEarningsCsv (rows) {
  const headers = [
    'Ride ID',
    'Date',
    'Driver',
    'Driver Phone',
    'Vehicle Plate',
    'Vehicle',
    'Pickup',
    'Dropoff',
    'Gross',
    'Driver Earning',
    'Vendor Commission',
    'Cancellation Fine',
    'Vendor Profit',
    'Platform Fee',
    'Payment Method',
    'Payment Status'
  ]
  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const row of rows) {
    const rideId = row.rideId && typeof row.rideId === 'object' && row.rideId._id
      ? String(row.rideId._id)
      : String(row.rideId ?? '')
    const vehicle = row.vehicle || {}
    const label = [vehicle.make, vehicle.model].filter(Boolean).join(' ')
    lines.push(
      [
        rideId,
        row.rideDate ? new Date(row.rideDate).toISOString() : '',
        row.driver?.name ?? '',
        row.driver?.phone ?? '',
        vehicle.licensePlate ?? '',
        label,
        row.pickupAddress ?? '',
        row.dropoffAddress ?? '',
        row.grossRevenue ?? 0,
        row.driverEarning ?? 0,
        row.vendorCommission ?? 0,
        row.cancellationFineCredit ?? 0,
        row.vendorProfit ?? row.vendorCommission ?? 0,
        row.platformFee ?? 0,
        row.paymentMethod ?? '',
        row.paymentStatus ?? ''
      ].map(escapeCsvCell).join(',')
    )
  }
  return lines.join('\n')
}

module.exports = {
  DEFAULT_RIDE_LIMIT,
  MAX_RIDE_LIMIT,
  MAX_CSV_RIDE_ROWS,
  MAX_DATE_RANGE_MS,
  clampRideLimit,
  clampRidePage,
  parseRideSort,
  sortRideWiseRows,
  paginateRideRows,
  normalizeLicensePlateFilter,
  dateRangeWarning,
  buildEarningsCsv
}
