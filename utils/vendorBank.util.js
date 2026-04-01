/**
 * Validation and normalization for vendor bank account payloads (India).
 */

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/
const MAX_LEN = 120
const ACCT_MIN = 5
const ACCT_MAX = 20

function trimStr(v) {
  if (v == null) return ''
  return String(v).trim()
}

function normalizeIfsc(code) {
  return trimStr(code).toUpperCase()
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateBankFields({ accountNumber, ifscCode, accountHolderName, bankName, accountType }) {
  const an = trimStr(accountNumber).replace(/\s/g, '')
  const ifsc = normalizeIfsc(ifscCode)
  const holder = trimStr(accountHolderName)
  const bank = trimStr(bankName)
  const at = trimStr(accountType).toUpperCase() || 'CURRENT'

  if (!an || an.length < ACCT_MIN || an.length > ACCT_MAX) {
    return { ok: false, message: `accountNumber must be ${ACCT_MIN}-${ACCT_MAX} characters` }
  }
  if (!/^[0-9]+$/.test(an)) {
    return { ok: false, message: 'accountNumber must contain digits only' }
  }
  if (!ifsc || !IFSC_REGEX.test(ifsc)) {
    return { ok: false, message: 'Invalid IFSC code format' }
  }
  if (!holder || holder.length > MAX_LEN) {
    return { ok: false, message: 'accountHolderName is required (max 120 chars)' }
  }
  if (!bank || bank.length > MAX_LEN) {
    return { ok: false, message: 'bankName is required (max 120 chars)' }
  }
  if (!['SAVINGS', 'CURRENT'].includes(at)) {
    return { ok: false, message: 'accountType must be SAVINGS or CURRENT' }
  }

  return {
    ok: true,
    value: {
      accountNumber: an,
      ifscCode: ifsc,
      accountHolderName: holder,
      bankName: bank,
      accountType: at,
    },
  }
}

const ALLOWED_KEYS = new Set(['accountNumber', 'ifscCode', 'accountHolderName', 'bankName', 'accountType'])

function pickBankUpdate(body) {
  if (!body || typeof body !== 'object') return {}
  const out = {}
  for (const k of ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k) && body[k] != null) {
      out[k] = body[k]
    }
  }
  return out
}

function assertVendorIdMatchesUser(paramVendorId, userId) {
  if (!paramVendorId || !userId) return false
  return String(paramVendorId) === String(userId)
}

module.exports = {
  validateBankFields,
  pickBankUpdate,
  assertVendorIdMatchesUser,
  normalizeIfsc,
  trimStr,
}
