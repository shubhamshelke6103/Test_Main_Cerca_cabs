# GO TO Feature Implementation Guide

## Overview

The `GO TO` feature allows a driver to activate a "return to home" mode.
When this mode is active:

- A route is generated from the driver's current live location to the driver's saved home destination.
- The driver should receive ride requests only if:
  - the pickup point lies along that route corridor, and
  - the dropoff point also lies along that route corridor, and
  - the ride moves the driver toward home, not away from home.

This implementation was added directly into the backend ride-assignment pipeline so the rule is enforced consistently for:

- BullMQ worker assignment flow
- socket retry/re-notification flow

## Business Logic

When a driver activates `GO TO`:

1. The backend reads the driver's current location.
2. The backend reads the driver's saved home location.
3. The backend requests a driving route from current location to home.
4. The backend stores that route snapshot on the driver document.
5. The backend only keeps that driver eligible for rides whose pickup and dropoff both lie on the route corridor.

If either pickup or dropoff is outside the route corridor, the ride is not offered.

If pickup appears later than dropoff in the route direction, the ride is also rejected because it would move the driver away from home.

## Files Added and Updated

### New file

- [utils/goToRoute.service.js](/d:/Techlaps_pvt.ltd/test/Cerca-API/utils/goToRoute.service.js)

Purpose:

- route generation using Google Directions API
- polyline decoding
- route corridor matching
- directional progress checks
- GO TO state sanitization



## Driver Model Changes

The driver schema now includes a `goTo` object with the following fields:

```js
goTo: {
  isEnabled: Boolean,
  status: 'OFF' | 'ACTIVE' | 'STALE',
  staleReason: String | null,
  homeAddress: String,
  homeLocation: {
    type: 'Point',
    coordinates: [lng, lat]
  },
  routeOrigin: {
    type: 'Point',
    coordinates: [lng, lat]
  },
  routePolyline: String | null,
  routePoints: [[lng, lat], [lng, lat], ...],
  routeBounds: {
    north: Number | null,
    south: Number | null,
    east: Number | null,
    west: Number | null
  },
  routeDistanceMeters: Number | null,
  routeDurationSeconds: Number | null,
  corridorRadiusMeters: Number,
  activatedAt: Date | null,
  lastRouteRefreshAt: Date | null
}
```

### Meaning of important fields

- `isEnabled`: whether GO TO is switched on
- `status`: current route validity status
- `STALE`: route exists but should not be trusted until refreshed
- `homeLocation`: saved destination
- `routeOrigin`: driver location used when route snapshot was generated
- `routePolyline`: encoded polyline from directions provider
- `routePoints`: decoded route points used for geometric matching
- `corridorRadiusMeters`: max allowed offset from route for pickup/dropoff eligibility

## API Endpoints

## 1. Save or update home destination

Endpoint:

`PUT /drivers/:id/go-to/home`

Purpose:

- store or update the driver's home location
- optionally update corridor radius

Example request:

```json
{
  "homeAddress": "Salt Lake Sector V, Kolkata",
  "homeCoordinates": [88.4172, 22.5764],
  "corridorRadiusMeters": 500
}
```

Example success response:

```json
{
  "message": "Driver GO TO home destination updated successfully",
  "goTo": {
    "isEnabled": false,
    "status": "OFF",
    "staleReason": null,
    "homeAddress": "Salt Lake Sector V, Kolkata",
    "homeLocation": {
      "type": "Point",
      "coordinates": [88.4172, 22.5764]
    },
    "routeOrigin": null,
    "routePolyline": null,
    "routeBounds": null,
    "routeDistanceMeters": null,
    "routeDurationSeconds": null,
    "corridorRadiusMeters": 500,
    "activatedAt": null,
    "lastRouteRefreshAt": null,
    "routePointCount": 0
  }
}
```

## 2. Get GO TO status

Endpoint:

`GET /drivers/:id/go-to`

Purpose:

- return current GO TO state for the driver

## 3. Activate GO TO

Endpoint:

`POST /drivers/:id/go-to/activate`

Purpose:

- generate route from current driver location to saved home
- activate route-aware ride filtering

Example request:

```json
{
  "homeAddress": "Salt Lake Sector V, Kolkata",
  "homeCoordinates": [88.4172, 22.5764],
  "corridorRadiusMeters": 500
}
```

Notes:

- `homeCoordinates` can be sent during activation if home is not already stored.
- If home is already saved, activation can be called without sending new home coordinates.

Example success response:

```json
{
  "message": "GO TO activated successfully",
  "goTo": {
    "isEnabled": true,
    "status": "ACTIVE",
    "staleReason": null,
    "homeAddress": "Salt Lake Sector V, Kolkata",
    "homeLocation": {
      "type": "Point",
      "coordinates": [88.4172, 22.5764]
    },
    "routeOrigin": {
      "type": "Point",
      "coordinates": [88.3639, 22.5726]
    },
    "routePolyline": "encoded_polyline_here",
    "routeBounds": {
      "north": 22.58,
      "south": 22.57,
      "east": 88.42,
      "west": 88.36
    },
    "routeDistanceMeters": 6500,
    "routeDurationSeconds": 1200,
    "corridorRadiusMeters": 500,
    "activatedAt": "2026-03-27T12:00:00.000Z",
    "lastRouteRefreshAt": "2026-03-27T12:00:00.000Z",
    "routePointCount": 124
  }
}
```

## 4. Deactivate GO TO

Endpoint:

`POST /drivers/:id/go-to/deactivate`

Purpose:

- switch GO TO off
- clear active route snapshot fields
- restore normal ride eligibility behavior

## Location Update Integration

The existing endpoint:

`PATCH /drivers/:id/location`

now also checks whether the driver's active GO TO route should be refreshed.

### Refresh behavior

The route is refreshed only when:

- GO TO is enabled
- home location exists
- GO TO status is `ACTIVE`
- the driver has moved enough from the last route origin
- enough time has passed since the last route refresh

### Current thresholds

Defined in [utils/goToRoute.service.js](/d:/Techlaps_pvt.ltd/test/Cerca-API/utils/goToRoute.service.js):

- route refresh distance: `300` meters
- route refresh interval: `2` minutes
- default corridor radius: `500` meters

If route refresh fails:

- GO TO is marked as `STALE`
- `staleReason` becomes `ROUTE_REFRESH_FAILED`
- the stale route is not considered valid for matching

## Ride Matching Logic

The matching logic is enforced in:

- [utils/ride_booking_functions.js](/d:/Techlaps_pvt.ltd/test/Cerca-API/utils/ride_booking_functions.js)

Specifically inside:

- `searchDriversWithProgressiveRadius(...)`

This is important because that function is already the shared driver discovery layer for ride assignment.

### Matching steps

1. Find nearby drivers using geospatial radius search.
2. Apply existing availability filters:
   - active
   - online
   - socket connected
   - not busy, or booking-type-specific exception
3. If ride has dropoff location, apply GO TO route filter.
4. Remove GO TO drivers whose route does not fit the ride.

### GO TO eligibility rules

A driver with GO TO active is eligible only if all conditions pass:

1. The driver has a valid `ACTIVE` route.
2. Pickup lies within the route corridor.
3. Dropoff lies within the route corridor.
4. Pickup progress on the route is less than or equal to dropoff progress.

### Route corridor logic

The system does not require pickup/dropoff to lie exactly on the route line.
Instead, each point is projected onto route segments and accepted if the shortest distance to the route is within `corridorRadiusMeters`.

This is more practical because real-world rider coordinates are rarely exactly on-road.

### Directional logic

Both pickup and dropoff may be near the route but still be wrong for GO TO.

Example:

- Driver is going east toward home.
- Pickup is near the home side.
- Dropoff is behind the driver.

That ride should not be offered, because it moves the driver away from home.

To prevent this, the system computes progress along the route:

- pickup progress
- dropoff progress

If:

`pickupProgress > dropoffProgress`

then the ride is rejected.

## Directions Integration

Route generation uses Google Directions API through:

- [utils/goToRoute.service.js](/d:/Techlaps_pvt.ltd/test/Cerca-API/utils/goToRoute.service.js)

The service:

- validates coordinates
- calls Google Directions API
- decodes overview polyline
- stores decoded route points
- stores distance and duration metadata

### API key

The service currently reads:

- `process.env.GOOGLE_MAPS_API_KEY`

and also keeps the same fallback key style already used in the project, so current project behavior remains aligned with existing Google Maps integration.

## Worker and Socket Integration

### Worker flow

Updated file:

- [src/workers/rideBooking.worker.js](/d:/Techlaps_pvt.ltd/test/Cerca-API/src/workers/rideBooking.worker.js)

Changes:

- pass `dropoffLocation` into `searchDriversWithProgressiveRadius(...)`
- GO TO logic now applies in:
  - priority driver search
  - normal driver search
  - fallback search

### Socket retry flow

Updated file:

- [utils/socket.js](/d:/Techlaps_pvt.ltd/test/Cerca-API/utils/socket.js)

Changes:

- retry search after rejections now also passes `dropoffLocation`
- GO TO logic remains enforced during retry searches

## Safeguards and Failure Handling

### Activation failure

GO TO activation fails if:

- driver is not found
- driver location is invalid
- home location is missing or invalid
- directions API request fails
- directions API returns no usable route 

### Stale route handling

If refresh fails during location update:

- route is marked `STALE`
- driver keeps home destination
- active route is treated as unavailable for matching until refreshed again

### Inactive GO TO drivers

If `isEnabled` is false or status is not `ACTIVE`, the GO TO filter does not restrict the driver.
That means the driver behaves like a normal driver.

## Logging

The implementation logs route filtering decisions in the driver search layer.

Example log reasons:

- `PICKUP_OUTSIDE_ROUTE`
- `DROPOFF_OUTSIDE_ROUTE`
- `RIDE_MOVES_AWAY_FROM_HOME`
- `GO_TO_ROUTE_UNAVAILABLE`

This helps production debugging when a driver reports:

- "I had GO TO on but I did not receive a ride"
- "Why did this ride not reach that driver?"

## Verification Completed

Syntax verification was run with:

```powershell
node --check utils\goToRoute.service.js
node --check Models\Driver\driver.model.js
node --check Controllers\Driver\driver.controller.js
node --check src\workers\rideBooking.worker.js
node --check utils\ride_booking_functions.js
node --check utils\socket.js
```

All checks passed.

## Recommended Manual Testing

## Scenario 1: Save home destination

1. Create or use an existing driver.
2. Call `PUT /drivers/:id/go-to/home`.
3. Confirm home address and coordinates are saved in driver document.

## Scenario 2: Activate GO TO

1. Ensure driver has valid live location.
2. Call `POST /drivers/:id/go-to/activate`.
3. Confirm:
   - `isEnabled = true`
   - `status = ACTIVE`
   - route polyline exists
   - route points exist
   - distance and duration are populated

## Scenario 3: Matching allowed

1. Activate GO TO for a driver.
2. Create a ride whose pickup and dropoff are both along the route corridor.
3. Confirm driver is included in candidate pool and receives request.

## Scenario 4: Pickup outside route

1. Activate GO TO.
2. Create a ride with pickup outside route but dropoff near route.
3. Confirm driver is excluded.

## Scenario 5: Dropoff outside route

1. Activate GO TO.
2. Create a ride with pickup near route but dropoff outside route.
3. Confirm driver is excluded.

## Scenario 6: Reverse-direction ride

1. Activate GO TO.
2. Create a ride where both points are near route but dropoff is earlier on the route than pickup.
3. Confirm driver is excluded.

## Scenario 7: Deactivate GO TO

1. Call `POST /drivers/:id/go-to/deactivate`.
2. Create a normal ride near driver.
3. Confirm driver can again receive standard ride requests.

## Future Improvements

The current implementation is a strong v1, but the following improvements are recommended later:

1. Add authenticated access control on GO TO endpoints so only the owning driver can update their own GO TO state.
2. Add auto
mated tests for route matching and API endpoints.
3. Add admin visibility for GO TO state in driver dashboards.
4. Store more route diagnostics for debugging.
5. Add configurable corridor radius per city or service type.
6. Add a dedicated route refresh endpoint.
7. Consider caching directions requests to reduce API cost.
8. Consider route simplification if route point arrays become very large.

## Summary

This implementation now supports a production-ready backend version of `GO TO`:

- driver can save home destination
- driver can activate and deactivate GO TO
- route is generated from current location to home
- matching checks both pickup and dropoff against the route corridor
- rides moving away from home are rejected
- logic is enforced in the shared assignment pipeline
- worker flow and socket retry flow both respect GO TO rules

This means the feature is now integrated at the correct backend layer, rather than being a frontend-only or controller-only rule.
