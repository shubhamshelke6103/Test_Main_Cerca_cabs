function roundMoney (n) {
  return Math.round(Number(n) * 100) / 100
}

function computeRideEarningsSplit (grossFare) {
  const g = Math.max(0, Number(grossFare) || 0)
  if (g <= 0) {
    return { platformFee: 0, driverEarning: 0, grossFare: 0 }
  }

  const platformFee = 5 + ((g - 100) / 100)
  const driverEarning = g - platformFee

  return {
    platformFee,
    driverEarning,
    grossFare: g
  }
}

module.exports = {
  roundMoney,
  computeRideEarningsSplit
}
