const Vendor = require('../../Models/vendor/vendor.models')
const VendorPayout = require('../../Models/Vendor/vendorPayout.model')
const Settings = require('../../Models/Admin/settings.modal')
const { validateBankFields } = require('../../utils/vendorBank.util')

async function sumReservedPayouts(vendorId) {
  const agg = await VendorPayout.aggregate([
    {
      $match: {
        vendor: vendorId,
        status: { $in: ['PENDING', 'PROCESSING'] }
      }
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ])
  return agg.length ? agg[0].total : 0
}

/**
 * GET /vendor/payout/available-balance
 */
exports.getVendorPayoutAvailableBalance = async (req, res) => {
  try {
    const vendorId = req.user.id
    const vendor = await Vendor.findById(vendorId).select('walletBalance bankAccount')
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    const settings = await Settings.findOne()
    const minPayoutThreshold = settings?.payoutConfigurations?.minPayoutThreshold ?? 500

    const wallet = Math.round((vendor.walletBalance || 0) * 100) / 100
    const reserved = Math.round((await sumReservedPayouts(vendorId)) * 100) / 100
    const available = Math.max(0, Math.round((wallet - reserved) * 100) / 100)

    const ba = vendor.bankAccount
    const hasBank =
      ba &&
      ba.accountNumber &&
      ba.ifscCode &&
      ba.accountHolderName &&
      ba.bankName

    return res.status(200).json({
      success: true,
      data: {
        walletBalance: wallet,
        reservedForPendingPayouts: reserved,
        availableBalance: available,
        minPayoutThreshold,
        canRequestPayout: available >= minPayoutThreshold && !!hasBank
      }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * GET /vendor/payout/history?page=1&limit=20
 */
exports.getVendorPayoutHistory = async (req, res) => {
  try {
    const vendorId = req.user.id
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const skip = (page - 1) * limit

    const [items, total] = await Promise.all([
      VendorPayout.find({ vendor: vendorId })
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VendorPayout.countDocuments({ vendor: vendorId })
    ])

    return res.status(200).json({
      success: true,
      data: {
        payouts: items,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit) || 1,
          total,
          limit
        }
      }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * POST /vendor/payout/request  { amount, notes? }
 */
exports.requestVendorPayout = async (req, res) => {
  try {
    const vendorId = req.user.id
    const amount = Number(req.body.amount)
    const notes = req.body.notes ? String(req.body.notes).slice(0, 500) : ''

    if (!amount || amount <= 0 || Number.isNaN(amount)) {
      return res.status(400).json({ success: false, message: 'Invalid payout amount' })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    const ba = vendor.bankAccount
    if (!ba || !ba.accountNumber || !ba.ifscCode || !ba.accountHolderName || !ba.bankName) {
      return res.status(400).json({
        success: false,
        message: 'Add a bank account before requesting a payout'
      })
    }

    const bankSnap = validateBankFields({
      accountNumber: ba.accountNumber,
      ifscCode: ba.ifscCode,
      accountHolderName: ba.accountHolderName,
      bankName: ba.bankName,
      accountType: ba.accountType
    })
    if (!bankSnap.ok) {
      return res.status(400).json({ success: false, message: bankSnap.message })
    }

    const settings = await Settings.findOne()
    const minPayoutThreshold = settings?.payoutConfigurations?.minPayoutThreshold ?? 500

    const wallet = Math.round((vendor.walletBalance || 0) * 100) / 100
    const reserved = Math.round((await sumReservedPayouts(vendorId)) * 100) / 100
    const available = Math.max(0, Math.round((wallet - reserved) * 100) / 100)

    if (amount < minPayoutThreshold) {
      return res.status(400).json({
        success: false,
        message: `Minimum payout amount is ₹${minPayoutThreshold}`
      })
    }

    if (amount > available) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient available balance for payout',
        data: { requested: amount, available }
      })
    }

    const pending = await VendorPayout.findOne({
      vendor: vendorId,
      status: { $in: ['PENDING', 'PROCESSING'] }
    })
    if (pending) {
      return res.status(400).json({
        success: false,
        message: 'You have a pending payout request. Please wait for it to be processed.'
      })
    }

    const payout = await VendorPayout.create({
      vendor: vendorId,
      amount: Math.round(amount * 100) / 100,
      bankAccount: bankSnap.value,
      notes: notes || undefined,
      status: 'PENDING'
    })

    return res.status(201).json({
      success: true,
      message: 'Payout request submitted',
      data: { payout }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}
