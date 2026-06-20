const REPORT_TZ = process.env.ADMIN_REPORT_TIMEZONE || 'Asia/Kolkata'

function getReportTimezone() {
  return REPORT_TZ
}

function getReportDayKey(date = new Date(), timeZone = REPORT_TZ) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone })
}

module.exports = {
  REPORT_TZ,
  getReportTimezone,
  getReportDayKey,
}
