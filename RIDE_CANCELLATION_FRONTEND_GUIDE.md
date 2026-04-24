# Ride Cancellation Feature - Frontend Integration Guide

## Overview
This document outlines the changes made to the ride cancellation system and provides guidance for frontend integration.

## Feature Description
Users can now cancel rides after driver acceptance, but cancellation charges apply only if neither the user nor driver has entered the start OTP (i.e., the ride has not started yet).

## Key Changes

### 1. Cancellation Logic Update
- **Previous Behavior**: Cancellation fees applied when ride status was 'accepted' or 'arrived'
- **New Behavior**: Cancellation fees apply only if the ride has not started (`startOtpVerifiedAt` is null)

### 2. Admin Configuration
The cancellation fee amount is configurable by admin through existing settings API.

## Frontend Integration Requirements

### 1. Cancellation UI Updates

#### Show Cancellation Fee Warning
When a user attempts to cancel a ride that hasn't started yet, display a warning about the cancellation fee.

```javascript
// Check if cancellation fee applies
const willChargeFee = !ride.startOtpVerifiedAt; // Ride hasn't started

if (willChargeFee) {
  // Show warning dialog with fee amount
  showCancellationWarning(feeAmount);
}
```

#### API Call for Cancellation
Continue using the existing socket event:

```javascript
socket.emit('rideCancelled', {
  rideId: rideId,
  cancelledBy: 'rider',
  reason: 'User cancelled' // Optional
});
```

### 2. Ride Status Display
Update UI to show when cancellation fees apply:

```javascript
const canCancelWithFee = ride.status === 'accepted' && !ride.startOtpVerifiedAt;
const canCancelFree = ride.status === 'accepted' && ride.startOtpVerifiedAt;

if (canCancelWithFee) {
  // Show "Cancel (₹50 fee applies)" button
} else if (canCancelFree) {
  // Show "Cancel (Free)" button
}
```

### 3. Admin Settings Management
If building admin panel, add cancellation fee configuration:

```javascript
// Get current settings
GET /admin/settings

// Update cancellation fee
PUT /admin/settings
{
  "pricingConfigurations": {
    "cancellationFees": 50
  }
}
```

## API Endpoints

### Existing Endpoints (No Changes)
- **Socket Event**: `rideCancelled`
  - Used for ride cancellation
  - Parameters: `{ rideId, cancelledBy, reason? }`

### Admin Endpoints (Existing)
- **GET** `/admin/settings` - Get all settings including cancellation fee
- **PUT** `/admin/settings` - Update settings including cancellation fee

## Data Flow

1. **User initiates cancellation** → Frontend emits `rideCancelled` socket event
2. **Server validates** → Checks if `startOtpVerifiedAt` exists
3. **Fee calculation** → If ride not started, applies admin-set cancellation fee
4. **Payment processing** → Deducts fee from wallet/payment method
5. **Refund processing** → Refunds remaining amount
6. **Notifications** → Sends cancellation confirmation to user and driver

## UI/UX Recommendations

### 1. Cancellation Button States
```javascript
// Different button states based on ride status
const getCancelButtonText = (ride) => {
  if (ride.status === 'requested') {
    return 'Cancel Ride (Free)';
  }
  if (ride.status === 'accepted' && !ride.startOtpVerifiedAt) {
    return `Cancel Ride (₹${cancellationFee} fee)`;
  }
  if (ride.status === 'accepted' && ride.startOtpVerifiedAt) {
    return 'Cancel Ride (Free)';
  }
  return 'Cannot Cancel';
};
```

### 2. Confirmation Dialog
```javascript
const showCancellationDialog = (ride, fee) => {
  const message = fee > 0
    ? `Are you sure you want to cancel? A cancellation fee of ₹${fee} will be charged.`
    : 'Are you sure you want to cancel this ride?';

  return confirm(message);
};
```

### 3. Post-Cancellation Feedback
```javascript
// After successful cancellation
showSuccessMessage('Ride cancelled successfully', {
  refundAmount: refundAmount,
  feeCharged: feeCharged
});
```

## Error Handling

### Common Error Scenarios
1. **Ride already started**: Show "Cannot cancel - ride in progress"
2. **Payment failure**: Show "Cancellation failed - payment error"
3. **Network issues**: Retry logic with exponential backoff

### Error Messages
```javascript
const errorMessages = {
  'RIDE_IN_PROGRESS': 'Cannot cancel ride that has already started',
  'PAYMENT_FAILED': 'Cancellation failed due to payment error',
  'INVALID_STATUS': 'Ride cannot be cancelled at this stage'
};
```

## Testing Checklist

### Frontend Tests
- [ ] Cancel before ride starts (should charge fee)
- [ ] Cancel after ride starts (should be free)
- [ ] Cancel in different ride statuses
- [ ] Error handling for failed cancellations
- [ ] UI updates after cancellation

### Integration Tests
- [ ] Socket event emission and reception
- [ ] Payment deduction and refund
- [ ] Notification delivery
- [ ] Admin fee configuration

## Migration Notes

### For Existing Rides
- Existing rides follow the new cancellation logic
- No data migration required
- Backward compatible with current ride states

### For Users
- Clear communication about when fees apply
- Update help/FAQ content
- In-app notifications about policy changes

## Support and Maintenance

### Monitoring
- Track cancellation rates
- Monitor fee collection
- Watch for payment failures

### Analytics
- Cancellation reasons
- Fee collection metrics
- User behavior patterns

---
