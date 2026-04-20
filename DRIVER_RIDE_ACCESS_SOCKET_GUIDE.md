# Driver Ride Access Socket Guide

This document explains the driver ride-tier toggle behavior for the frontend team.

## Goal

Drivers can control which lower-tier rides they accept, based on their active vehicle:

- `Cerca Zip`: no toggle buttons
- `Cerca Glide`: one toggle for `Cerca Zip`
- `Cerca Titan`: two toggles, one for `Cerca Glide` and one for `Cerca Zip`

The online/offline driver toggle stays separate from ride-tier preferences.

## Socket Events

### 1. Driver connection

Emit when the driver app connects:

```json
{
  "driverId": "DRIVER_ID"
}
```

Event name: `driverConnect`

### 2. Online/offline toggle

This keeps the existing behavior for accepting rides generally:

```json
{
  "driverId": "DRIVER_ID",
  "isOnline": true
}
```

Event name: `driverToggleStatus`

### 3. Ride access preference update

Use this new event for the Zip/Glide/Titan ride-tier toggles:

```json
{
  "driverId": "DRIVER_ID",
  "rideAccess": {
    "allowZip": true,
    "allowGlide": false
  }
}
```

Event name: `driverRidePreferenceUpdate`

Supported aliases:

- `allowZip` / `zip` / `enableZip`
- `allowGlide` / `glide` / `enableGlide`

## Data Returned to the Driver App

The backend now includes ride access data in `driverStatusUpdate`.

Example payload:

```json
{
  "driverId": "DRIVER_ID",
  "isOnline": true,
  "isActive": true,
  "isBusy": false,
  "vehicleType": "cercaTitan",
  "rideAccess": {
    "allowZip": true,
    "allowGlide": false
  },
  "availableRideToggles": ["allowGlide", "allowZip"],
  "allowedRideTypes": ["cercaTitan", "cercaZip"],
  "message": "Ride access updated successfully"
}
```

The app should use:

- `availableRideToggles` to decide which switches to show
- `rideAccess` to decide switch ON/OFF state
- `allowedRideTypes` for debugging or display

## UI Rules

### If active vehicle is `cercaZip`

- Show no ride-tier toggles
- Driver always receives `Cerca Zip` rides only

### If active vehicle is `cercaGlide`

- Show one toggle: `Receive Cerca Zip rides`
- Base `Cerca Glide` rides are always allowed

### If active vehicle is `cercaTitan`

- Show two toggles:
  - `Receive Cerca Glide rides`
  - `Receive Cerca Zip rides`
- Base `Cerca Titan` rides are always allowed

## Suggested Frontend Logic

```js
socket.on('driverStatusUpdate', (data) => {
  setVehicleType(data.vehicleType);
  setRideAccess(data.rideAccess);
  setAvailableRideToggles(data.availableRideToggles || []);
  setAllowedRideTypes(data.allowedRideTypes || []);
});

const updateRidePreference = (payload) => {
  socket.emit('driverRidePreferenceUpdate', {
    driverId,
    rideAccess: payload
  });
};
```

## Important Notes

- Do not use `driverToggleStatus` for ride-tier toggles.
- If the driver changes active vehicle, the backend resets the ride access defaults automatically.
- Ride matching on the backend now respects these preferences, so drivers only receive the ride tiers they enabled.

## Acceptance Matrix

| Vehicle | Always gets | Optional toggles |
|---|---|---|
| Cerca Zip | Zip | None |
| Cerca Glide | Glide | Zip |
| Cerca Titan | Titan | Glide, Zip |

## Recommended Labels

- `Cerca Zip rides`
- `Cerca Glide rides`
- `Cerca Titan rides`

