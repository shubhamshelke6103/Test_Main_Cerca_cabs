const Vendor = require('../Models/vendor/vendor.models')
const Driver = require('../Models/Driver/driver.model')
const AdminEarnings = require('../Models/Admin/adminEarnings.model')
const VendorPayout = require('../Models/vendor/vendorPayout.model')

const roundCurrency = value => Math.round((Number(value) || 0) * 100) / 100

const calculateVendorCommission = (vendor, driverEarning) => {
  const normalizedDriverEarning = Number(driverEarning) || 0
  if (!vendor || normalizedDriverEarning <= 0) return 0

  if (vendor.commissionType === 'FIXED') {
    return roundCurrency(
      Math.min(Number(vendor.commissionValue) || 0, normalizedDriverEarning)
    )
  }

  return roundCurrency(
    normalizedDriverEarning * ((Number(vendor.commissionValue) || 0) / 100)
  )
}

const buildVendorEarningsFilter = ({ driverIds, startDate, endDate }) => {
  const filter = {
    driverId: { $in: driverIds },
    paymentStatus: 'completed'
  }

  if (startDate || endDate) {
    filter.rideDate = {}
    if (startDate) filter.rideDate.$gte = new Date(startDate)
    if (endDate) filter.rideDate.$lte = new Date(endDate)
  }

  return filter
}

const getVendorBaseContext = async vendorId => {
  const vendor = await Vendor.findById(vendorId)
    .select(
      'businessName commissionType commissionValue walletBalance totalEarnings totalRides totalDrivers bankAccount'
    )
    .lean()

  if (!vendor) {
    return { vendor: null, drivers: [], driverIds: [] }
  }

  const drivers = await Driver.find({ vendorId })
    .select('name phone email isOnline isActive isVerified totalEarnings rideRejectionCount')
    .lean()

  return {
    vendor,
    drivers,
    driverIds: drivers.map(driver => driver._id)
  }
}

const getVendorEarningsReportData = async ({ vendorId, startDate, endDate }) => {
  const { vendor, driverIds } = await getVendorBaseContext(vendorId)

  if (!vendor || driverIds.length === 0) {
    return {
      vendor,
      summary: {
        totalGrossRevenue: 0,
        totalDriverEarnings: 0,
        totalVendorCommission: 0,
        totalPlatformFee: 0,
        rideCount: 0
      },
      driverWiseEarnings: [],
      rideWiseRevenue: []
    }
  }

  const earnings = await AdminEarnings.find(
    buildVendorEarningsFilter({ driverIds, startDate, endDate })
  )
    .populate('rideId', 'pickupAddress dropoffAddress fare createdAt paymentMethod')
    .populate('driverId', 'name phone email')
    .sort({ rideDate: -1 })
    .lean()

  const rideWiseRevenue = earnings.map(entry => {
    const vendorCommission = calculateVendorCommission(vendor, entry.driverEarning)
    return {
      earningId: entry._id,
      rideId: entry.rideId?._id || null,
      rideDate: entry.rideDate,
      driver: entry.driverId
        ? {
            id: entry.driverId._id,
            name: entry.driverId.name,
            phone: entry.driverId.phone,
            email: entry.driverId.email || null
          }
        : null,
      pickupAddress: entry.rideId?.pickupAddress || null,
      dropoffAddress: entry.rideId?.dropoffAddress || null,
      grossRevenue: roundCurrency(entry.grossFare),
      platformFee: roundCurrency(entry.platformFee),
      driverEarning: roundCurrency(entry.driverEarning),
      vendorCommission,
      vendorProfit: vendorCommission,
      paymentStatus: entry.paymentStatus
    }
  })

  const driverWiseMap = new Map()
  for (const row of rideWiseRevenue) {
    if (!row.driver?.id) continue
    const key = row.driver.id.toString()
    if (!driverWiseMap.has(key)) {
      driverWiseMap.set(key, {
        driverId: row.driver.id,
        name: row.driver.name,
        phone: row.driver.phone,
        email: row.driver.email || null,
        rideCount: 0,
        grossRevenue: 0,
        driverEarning: 0,
        vendorCommission: 0
      })
    }

    const current = driverWiseMap.get(key)
    current.rideCount += 1
    current.grossRevenue += row.grossRevenue || 0
    current.driverEarning += row.driverEarning || 0
    current.vendorCommission += row.vendorCommission || 0
  }

  const driverWiseEarnings = Array.from(driverWiseMap.values()).map(item => ({
    ...item,
    grossRevenue: roundCurrency(item.grossRevenue),
    driverEarning: roundCurrency(item.driverEarning),
    vendorCommission: roundCurrency(item.vendorCommission)
  }))

  const summary = rideWiseRevenue.reduce(
    (acc, row) => {
      acc.totalGrossRevenue += row.grossRevenue || 0
      acc.totalDriverEarnings += row.driverEarning || 0
      acc.totalVendorCommission += row.vendorCommission || 0
      acc.totalPlatformFee += row.platformFee || 0
      acc.rideCount += 1
      return acc
    },
    {
      totalGrossRevenue: 0,
      totalDriverEarnings: 0,
      totalVendorCommission: 0,
      totalPlatformFee: 0,
      rideCount: 0
    }
  )

  return {
    vendor,
    summary: {
      totalGrossRevenue: roundCurrency(summary.totalGrossRevenue),
      totalDriverEarnings: roundCurrency(summary.totalDriverEarnings),
      totalVendorCommission: roundCurrency(summary.totalVendorCommission),
      totalPlatformFee: roundCurrency(summary.totalPlatformFee),
      rideCount: summary.rideCount
    },
    driverWiseEarnings,
    rideWiseRevenue
  }
}

const getVendorFinancialSnapshot = async vendorId => {
  const { vendor, driverIds } = await getVendorBaseContext(vendorId)

  if (!vendor || driverIds.length === 0) {
    return {
      vendor,
      driverIds,
      totalCompletedCommission: 0,
      totalCompletedRides: 0,
      availableBalance: 0,
      pendingPayoutAmount: 0,
      processingPayoutAmount: 0,
      paidOutAmount: 0,
      reservedCommissionAmount: 0,
      completedEarningsCount: 0,
      eligibleEarningsCount: 0,
      reservedEarningIds: new Set(),
      eligibleCommissionRows: []
    }
  }

  const [completedEarnings, payouts] = await Promise.all([
    AdminEarnings.find({
      driverId: { $in: driverIds },
      paymentStatus: 'completed'
    })
      .select('driverId rideId driverEarning grossFare platformFee rideDate')
      .lean(),
    VendorPayout.find({
      vendor: vendorId,
      status: { $in: ['PENDING', 'PROCESSING', 'COMPLETED'] }
    })
      .select('status amount relatedEarnings')
      .lean()
  ])

  const reservedEarningIds = new Set()
  payouts.forEach(payout => {
    if (!Array.isArray(payout.relatedEarnings)) return
    payout.relatedEarnings.forEach(earningId => {
      if (earningId) reservedEarningIds.add(earningId.toString())
    })
  })

  const completedCommissionRows = completedEarnings.map(earning => ({
    earningId: earning._id?.toString(),
    rideId: earning.rideId || null,
    driverId: earning.driverId || null,
    driverEarning: roundCurrency(earning.driverEarning),
    vendorCommission: calculateVendorCommission(vendor, earning.driverEarning),
    rideDate: earning.rideDate
  }))

  const eligibleCommissionRows = completedCommissionRows.filter(
    row => row.earningId && !reservedEarningIds.has(row.earningId)
  )

  const totalCompletedCommission = roundCurrency(
    completedCommissionRows.reduce(
      (sum, row) => sum + (row.vendorCommission || 0),
      0
    )
  )
  const availableBalance = roundCurrency(
    eligibleCommissionRows.reduce(
      (sum, row) => sum + (row.vendorCommission || 0),
      0
    )
  )
  const pendingPayoutAmount = roundCurrency(
    payouts
      .filter(payout => payout.status === 'PENDING')
      .reduce((sum, payout) => sum + (payout.amount || 0), 0)
  )
  const processingPayoutAmount = roundCurrency(
    payouts
      .filter(payout => payout.status === 'PROCESSING')
      .reduce((sum, payout) => sum + (payout.amount || 0), 0)
  )
  const paidOutAmount = roundCurrency(
    payouts
      .filter(payout => payout.status === 'COMPLETED')
      .reduce((sum, payout) => sum + (payout.amount || 0), 0)
  )

  return {
    vendor,
    driverIds,
    totalCompletedCommission,
    totalCompletedRides: completedEarnings.length,
    availableBalance,
    pendingPayoutAmount,
    processingPayoutAmount,
    paidOutAmount,
    reservedCommissionAmount: roundCurrency(
      totalCompletedCommission - availableBalance
    ),
    completedEarningsCount: completedCommissionRows.length,
    eligibleEarningsCount: eligibleCommissionRows.length,
    reservedEarningIds,
    eligibleCommissionRows
  }
}

const syncVendorFinancialFields = async (vendorId, snapshot) => {
  const resolvedSnapshot =
    snapshot || (await getVendorFinancialSnapshot(vendorId))

  if (!resolvedSnapshot.vendor) return resolvedSnapshot

  await Vendor.findByIdAndUpdate(vendorId, {
    $set: {
      walletBalance: resolvedSnapshot.availableBalance,
      totalEarnings: resolvedSnapshot.totalCompletedCommission,
      totalRides: resolvedSnapshot.totalCompletedRides
    }
  })

  return resolvedSnapshot
}

module.exports = {
  roundCurrency,
  calculateVendorCommission,
  getVendorBaseContext,
  getVendorEarningsReportData,
  getVendorFinancialSnapshot,
  syncVendorFinancialFields
}
