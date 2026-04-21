# Driver Ride Preference Guide

This guide is for the frontend developer.

It explains how driver ride preferences work for:

- `Cerca Zip`
- `Cerca Glide`
- `Cerca Titan`

## Core Rule

The driver's own vehicle category is always allowed by default.

Only the lower ride tiers are optional toggles.

## UI Rules

### If driver vehicle is `Cerca Zip`

- Show no ride preference toggles
- Driver only receives `Cerca Zip` rides

### If driver vehicle is `Cerca Glide`

- Show 1 toggle
- Toggle label: `Receive Cerca Zip rides`
- `Cerca Glide` rides are always allowed
- `Cerca Zip` rides are optional

### If driver vehicle is `Cerca Titan`

- Show 2 toggles
- Toggle label 1: `Receive Cerca Glide rides`
- Toggle label 2: `Receive Cerca Zip rides`
- `Cerca Titan` rides are always allowed
- `Cerca Glide` and `Cerca Zip` are optional

## Socket Events

### 1. Driver connect

Emit when the driver app opens or reconnects:

```json
{
  "driverId": "DRIVER_ID"
}
```

Event: `driverConnect`

### 2. Online/offline toggle

This is the existing accept-rides switch:

```json
{
  "driverId": "DRIVER_ID",
  "isOnline": true
}
```

Event: `driverToggleStatus`

Use this only for online/offline.
Do not use it for ride preference toggles.

### 3. Ride preference update

Use this new event for the ride-tier toggles:

```json
{
  "driverId": "DRIVER_ID",
  "rideAccess": {
    "allowZip": true,
    "allowGlide": false
  }
}
```

Event: `driverRidePreferenceUpdate`

You can also send these aliases:

- `allowZip`, `zip`, `enableZip`
- `allowGlide`, `glide`, `enableGlide`

## Data Returned by Backend

The backend returns ride preference data inside `driverStatusUpdate`.

Example:

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
  "allowedRideTypes": ["cercaTitan", "cercaZip"]
}
```

## What Each Field Means

- `vehicleType`
  - current active vehicle category
- `rideAccess`
  - current toggle values saved in DB
- `availableRideToggles`
  - which toggles should be shown in UI
- `allowedRideTypes`
  - which ride types the driver can currently receive

## Suggested Frontend Logic

```js
socket.on('driverStatusUpdate', (data) => {
  setVehicleType(data.vehicleType);
  setRideAccess(data.rideAccess || {});
  setAvailableRideToggles(data.availableRideToggles || []);
  setAllowedRideTypes(data.allowedRideTypes || []);
});

const updateRideAccess = (nextAccess) => {
  socket.emit('driverRidePreferenceUpdate', {
    driverId,
    rideAccess: nextAccess
  });
};
```

## Toggle Matrix

| Vehicle | Always allowed | Optional toggles |
|---|---|---|
| `Cerca Zip` | `Cerca Zip` | None |
| `Cerca Glide` | `Cerca Glide` | `Cerca Zip` |
| `Cerca Titan` | `Cerca Titan` | `Cerca Glide`, `Cerca Zip` |

## Important Notes

- Driver ride preferences are separate from online/offline status.
- If the driver changes vehicle type, the backend resets the available toggles automatically.
- Ride matching on the backend respects these preferences, so drivers will only receive rides they enabled.

