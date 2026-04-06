const maskPhone = value => {
  if (!value) return null
  const stringValue = String(value)
  if (stringValue.length <= 4) return stringValue
  return `${'*'.repeat(Math.max(0, stringValue.length - 4))}${stringValue.slice(-4)}`
}

const toPlainObject = value => {
  if (!value) return value
  if (typeof value.toObject === 'function') {
    return value.toObject()
  }
  return { ...value }
}

const sanitizeContactForDriver = contact => {
  if (!contact || Array.isArray(contact)) return contact

  const sanitizedContact = toPlainObject(contact)
  const actualPhone =
    sanitizedContact.phoneNumber || sanitizedContact.phone || null

  if (!actualPhone) {
    return sanitizedContact
  }

  const maskedPhoneNumber = maskPhone(actualPhone)

  return {
    ...sanitizedContact,
    maskedPhoneNumber,
    callPhoneNumber: actualPhone,
    ...(Object.prototype.hasOwnProperty.call(sanitizedContact, 'phoneNumber')
      ? { phoneNumber: maskedPhoneNumber }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedContact, 'phone')
      ? { phone: maskedPhoneNumber }
      : {})
  }
}

const sanitizeRideContactsForDriver = ride => {
  if (!ride) return ride

  const sanitizedRide = toPlainObject(ride)

  if (
    sanitizedRide.rider &&
    typeof sanitizedRide.rider === 'object' &&
    !Array.isArray(sanitizedRide.rider)
  ) {
    sanitizedRide.rider = sanitizeContactForDriver(sanitizedRide.rider)
  }

  if (
    sanitizedRide.passenger &&
    typeof sanitizedRide.passenger === 'object' &&
    !Array.isArray(sanitizedRide.passenger)
  ) {
    sanitizedRide.passenger = sanitizeContactForDriver(sanitizedRide.passenger)
  }

  return sanitizedRide
}

const sanitizeRideListContactsForDriver = rides =>
  Array.isArray(rides)
    ? rides.map(sanitizeRideContactsForDriver)
    : sanitizeRideContactsForDriver(rides)

module.exports = {
  maskPhone,
  sanitizeContactForDriver,
  sanitizeRideContactsForDriver,
  sanitizeRideListContactsForDriver
}
