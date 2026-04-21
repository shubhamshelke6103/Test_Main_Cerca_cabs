# Intercity Ride Frontend Guide

This document is the full frontend handoff for the Intercity Ride flow.
It includes the user journey, data contract, matching behavior, scheduled logic, and the driver lifecycle after acceptance.

## 1. Product Goal

Intercity ride is an end-to-end booking experience for rides between different cities.
The frontend must support:

- search and quote
- one-way and round-trip selection
- now and scheduled booking
- vehicle selection
- fare preview
- booking status updates
- upcoming scheduled ride handling
- standard ride workflow after acceptance
- driver intercity availability toggle

## 2. End-to-End User Flow

### User booking flow

1. User opens the app
2. User opens the Service page
3. User selects `Intercity Ride`
4. User enters pickup location
5. User enters drop location
6. System confirms pickup and drop are in different cities
7. User selects ride type:
   - `one_way`
   - `round_trip`
8. User selects schedule type:
   - `now`
   - `scheduled`
9. If `scheduled`, user selects date and time
10. User taps `Search Ride`
11. App receives fare estimate and available vehicle types
12. User selects vehicle type
13. User confirms booking
14. If `now`, request is dispatched immediately to drivers
15. If `scheduled`, booking is stored and matched by cron later

### Driver flow

1. Driver goes online
2. Driver can enable intercity toggle only after 50 completed standard rides
3. Driver receives intercity requests in small batches
4. Driver accepts one ride
5. Ride disappears from other drivers
6. If the ride is scheduled, it appears in `Upcoming Rides`
7. On the scheduled day and time, driver opens the ride
8. Driver follows the normal ride workflow:
   - Driver Arrived
   - Start OTP
   - Start ride
   - Stop OTP
   - Complete ride

## 3. Key Rules

- Pickup and drop must be in different cities.
- Intercity rides must never be shown to a driver who is already occupied with an intercity ride.
- A driver can enable intercity only after successfully completing 50 standard rides.
- `scheduleType = now` means dispatch immediately after booking.
- `scheduleType = scheduled` means create a planned ride and match it later via cron.
- Scheduled intercity rides must appear in `Upcoming Rides` once accepted.
- Once one driver accepts a ride, it must not be visible to other drivers.
- Intercity accepted rides use the same standard ride checkpoints as normal rides.

## 4. Driver Intercity Toggle Rule

The frontend should show the intercity toggle only when backend allows it.

Validation rule:

- The driver must have at least `50` completed standard rides.
- If the driver has fewer than 50, show a locked state or disabled toggle.
- Show a clear message like:
  - `Intercity ride access unlocks after 50 completed standard rides.`

Recommended UI states:

- disabled toggle
- enabled toggle
- loading state while saving
- error state when backend rejects the toggle

## 5. Booking Types and Schedule Types

### rideType

- `normal`
- `intercity`

For this feature, the frontend should use:

- `rideType = intercity`

### tripMode

- `one_way`
- `round_trip`

### scheduleType

- `now`
- `scheduled`

If `scheduleType = scheduled`, the frontend must send the scheduled datetime.

## 6. Intercity Booking Payload

Use this shape when searching or creating intercity rides.

```json
{
  "rideType": "intercity",
  "tripMode": "one_way",
  "scheduleType": "now",
  "pickupLocation": {
    "latitude": 28.6139,
    "longitude": 77.209
  },
  "dropoffLocation": {
    "latitude": 19.076,
    "longitude": 72.8777
  },
  "pickupCity": "Delhi",
  "dropCity": "Mumbai",
  "vehicleType": "cercaZip",
  "scheduledAt": "2026-04-25T10:30:00.000Z",
  "tollCharges": 50,
  "parkingCharges": 20
}
```

### Field notes

- `pickupLocation` and `dropoffLocation` are required.
- `pickupCity` and `dropCity` are used for a different-city check.
- `scheduledAt` is required when `scheduleType = scheduled`.
- `vehicleType` should match backend-supported vehicle keys.
- `tripMode` should be sent explicitly.

## 7. Search And Quote Behavior

When the user taps `Search Ride`:

1. Validate pickup
2. Validate drop
3. Validate cities are different
4. Validate schedule type
5. Validate `scheduledAt` if needed
6. Request fare estimate from backend
7. Show fare estimate
8. Show available vehicle types
9. Let user confirm the ride

The frontend should not calculate the final fare itself.
It should display backend estimate and breakdown.

## 8. Fare Calculation Summary

Final fare formula:

`Base Fare + Distance Fare + Toll Charges + Parking Charges + Driver Allowance`

### Round-trip allowance rules

- First 24 hours: `₹300`
- Next 24 hours: `₹500`
- After that: `₹500` per additional 24-hour block

### Extra distance allowance rules

If distance exceeds `300 km` in a day:

- Glide: `₹12/km`
- Zip: `₹10/km`
- Titan: `₹16/km`

These values are configurable from backend settings and should be displayed as estimates only.

## 9. Fare Estimate Response

The frontend should expect a response shaped like this:

```json
{
  "success": true,
  "rideType": "intercity",
  "scheduleType": "now",
  "data": {
    "distance": 412.6,
    "estimatedDuration": 640,
    "fareBreakdown": {
      "baseFare": 100,
      "distanceFare": 4126,
      "timeFare": 0,
      "subtotal": 4426,
      "fareAfterMinimum": 4426,
      "discount": 0,
      "finalFare": 4426,
      "tollCharges": 50,
      "parkingCharges": 20,
      "driverAllowance": 300
    },
    "availableVehicleTypes": ["cercaZip", "cercaGlide", "cercaTitan"]
  }
}
```

### Frontend display recommendations

- show distance in km
- show estimated duration
- show fare breakdown cards
- show toll charges separately
- show parking separately
- show driver allowance separately for round trip

## 10. Batch-Based Driver Matching

Intercity rides must use cost-saving batch matching.

### Matching behavior

- Do not broadcast to all drivers
- Send request to only the top `5` eligible drivers
- Wait `30-60 seconds`
- If no one accepts, move to the next batch
- Continue until accepted or all batches are exhausted

### Eligible driver filters

- online
- intercity toggle enabled
- within pickup radius
- vehicle type matches
- not already busy
- has valid socket connection

### Sorting rule

- nearest first

### Frontend impact

- The user should see a normal “searching for driver” state
- Do not assume a live broadcast to many drivers
- The system may take a few batch cycles before success

## 11. `scheduleType = now`

When `scheduleType = now`:

- booking should be dispatched immediately
- driver batch matching starts right away
- once a driver accepts, the user should receive a success state without delay
- this is a live booking flow

Suggested frontend states:

- `Searching`
- `Driver Found`
- `Ride Accepted`
- `Ride Assigned`

## 12. `scheduleType = scheduled`

When `scheduleType = scheduled`:

- the ride is stored as a planned intercity booking
- cron processes upcoming scheduled rides every 5-10 minutes
- the app should show it as a future booking
- reminders are sent to user and driver

### Reminder timings

- 1 day before
- 1 hour before

### Frontend states

- `Scheduled`
- `Upcoming Rides`
- `Reminder Sent`
- `Ready for Trip`

## 13. Upcoming Ride Workflow

This is important for the frontend.

On the scheduled day and time, after the driver opens the ride from `Upcoming Rides`:

- the ride must behave like a standard ride
- no separate special flow is needed
- the driver should use the same controls as a regular ride

### Standard ride workflow to support

- `Driver Arrived`
- `Start OTP`
- `Ride Started`
- `Stop OTP`
- `Ride Completed`

### Important behavior

- Scheduled intercity rides are not auto-started by the app UI
- The driver manually opens the upcoming ride
- The ride then follows the normal ride state transitions

## 14. Driver Ride States

The frontend should expect the following ride progression:

- `requested`
- `accepted`
- `arrived`
- `in_progress`
- `completed`
- `cancelled`

For intercity rides, the same statuses are used.

## 15. Driver Busy And Ride Exclusivity

Once a driver is assigned an intercity ride:

- no other rides should be shown to that driver
- the driver should appear busy
- intercity assignment should lock the driver until completion

Frontend should reflect this by:

- hiding unavailable actions
- preventing multiple ride acceptance UI
- showing a current active ride card

## 16. Notifications

### User notifications

- ride request accepted
- reminder 1 day before scheduled trip
- reminder 1 hour before scheduled trip
- driver arrived
- ride started
- ride completed
- ride cancelled

### Driver notifications

- new intercity ride request
- upcoming scheduled intercity reminder
- ride accepted
- ride arrived
- ride started
- ride completed

## 17. Recommended Screens

### User side

- Service selection page
- Intercity search form
- Fare estimate screen
- Vehicle selection screen
- Booking confirmation screen
- Scheduled booking summary screen
- Ride tracking screen

### Driver side

- Availability toggle screen
- Intercity eligibility state
- Incoming ride request card
- Upcoming rides list
- Active ride detail screen
- Standard workflow action bar

## 18. Suggested UI States

### User

- idle
- validating
- estimating
- searching
- matched
- scheduled
- upcoming
- in_trip
- completed
- cancelled

### Driver

- offline
- online
- intercity_locked
- intercity_enabled
- receiving_request
- accepted
- upcoming
- arrived
- in_progress
- completed

## 19. Error States To Handle

Show clear messages for:

- pickup/drop missing
- pickup/drop same city
- invalid scheduled time
- intercity disabled
- intercity toggle locked due to fewer than 50 standard rides
- no drivers available
- ride already accepted by another driver
- scheduled ride could not be matched
- ride cancelled by system

## 20. Frontend Integration Tips

- Keep `scheduleType` explicit in every request.
- Use backend `fareBreakdown` for all price rendering.
- Treat scheduled intercity rides as future jobs, not live rides.
- Reuse the regular ride-progress UI after the driver opens the ride from `Upcoming Rides`.
- Do not create a separate completion flow for intercity rides.
- Use the same OTP and status controls as normal rides.

## 21. Example Quick Summary

### Now ride

1. User selects intercity
2. User enters pickup and drop
3. User selects `now`
4. App gets estimate
5. User confirms
6. Backend immediately dispatches to top 5 drivers
7. First acceptance locks the ride
8. Driver performs standard ride flow

### Scheduled ride

1. User selects intercity
2. User enters pickup and drop
3. User selects `scheduled`
4. User selects date and time
5. App gets estimate
6. User confirms
7. Ride is stored
8. Cron batches matching before trip time
9. Driver sees ride in `Upcoming Rides`
10. On trip day, driver opens ride
11. Driver performs standard ride flow

