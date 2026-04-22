# Proximity Ride Assignment Feature

## Overview
This feature automatically assigns new ride requests to drivers who are approaching their current ride's destination. When a driver is within 15 minutes travel time or 5 km of their destination, the system searches for available rides near that destination and sends them to the driver.

## Configuration
The feature is configured via `config/proximityConfig.json`:

```json
{
  "proximityRideAssignment": {
    "enabled": true,
    "maxTravelTimeMinutes": 15,
    "maxDistanceKm": 5,
    "searchRadiusKm": 3,
    "maxConcurrentRides": 1,
    "notificationCooldownMinutes": 5,
    "maxProximityRidesPerHour": 10
  }
}
```

### Configuration Parameters
- `enabled`: Enable/disable the feature
- `maxTravelTimeMinutes`: Maximum travel time to destination to trigger proximity search (default: 15 minutes)
- `maxDistanceKm`: Maximum distance to destination to trigger proximity search (default: 5 km)
- `searchRadiusKm`: Radius around destination to search for new rides (default: 3 km)
- `maxConcurrentRides`: Maximum concurrent ride assignments allowed
- `notificationCooldownMinutes`: Minimum time between proximity notifications (default: 5 minutes)
- `maxProximityRidesPerHour`: Maximum proximity ride notifications per driver per hour (default: 10)

## How It Works

1. **Location Update**: Driver app sends location updates during `in_progress` rides
2. **Proximity Check**: System calculates ETA/distance to destination using Google Maps API
3. **Threshold Check**: If within configured time/distance limits, system searches for nearby rides
4. **Ride Search**: Finds `requested` rides within search radius of destination
5. **Notification**: Sends proximity ride notification to driver via socket and push notification
6. **Assignment**: Driver can accept/reject like normal ride requests

## Technical Implementation

### Files Modified/Created
- `config/proximityConfig.json` - Configuration file
- `utils/proximityRide.service.js` - Core proximity logic
- `Controllers/Driver/driver.controller.js` - Integration with location updates
- `Models/User/notification.model.js` - Added proximity notification type

### Key Functions
- `checkDriverProximityToDestination()` - Checks if driver is near destination
- `findRidesNearDestination()` - Searches for rides near a location
- `checkAndAssignProximityRides()` - Main orchestration function
- `canReceiveProximityRide()` - Checks eligibility and rate limits

### API Integration
- Uses Google Maps Directions API for accurate travel time/distance
- Falls back to Haversine distance calculation if API fails
- Integrates with existing socket.io and notification systems

### Rate Limiting
- Cooldown period between notifications (configurable)
- Hourly limits per driver
- Prevents spam when driver is stuck in traffic

## Testing
Run tests with:
```bash
npm test -- tests/proximityRide.service.test.js
```

## Monitoring
Monitor logs for:
- Proximity check events
- Ride assignment success/failure
- API errors and fallbacks
- Rate limiting triggers

## Benefits
- **Seamless Experience**: Drivers can continue working without returning to pickup areas
- **Increased Efficiency**: Reduces dead time between rides
- **Better Utilization**: Maximizes driver working hours
- **Customer Satisfaction**: Faster pickup times for subsequent rides