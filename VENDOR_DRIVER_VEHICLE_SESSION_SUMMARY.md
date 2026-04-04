# Vendor Driver And Vehicle Session Summary

## Scope Completed

This session implemented and updated the vendor-driver visibility and vehicle reassignment workflow.

### 1. Vendor driver visibility

Vendor driver listing now supports:

- Default view:
  - self-registered drivers
  - drivers created under the logged-in vendor
- Filter by vendor name:
  - returns only drivers assigned to the matched vendor
- Filter by self-registered:
  - returns only self-registered drivers

### 2. Vehicle reassignment workflow

A vendor can now attempt to assign a fleet vehicle to any driver, but assignment is blocked until the correct party removes the driver's existing vehicle state first.

Rules implemented:

- If the driver is self-registered and has a vehicle:
  - the driver must delete their own vehicle first
- If the driver belongs to another vendor and has a vendor-owned vehicle:
  - only the original vendor can remove that vehicle
  - the new vendor cannot remove it
- If the driver belongs to the current vendor and already has vehicle state:
  - the current vendor must remove it first before assigning a different vehicle
- A vendor-created driver cannot delete their own vehicle
- A self-registered driver can delete their own vehicle

## Important Error Messages

These messages are now enforced in code:

- `Please ask the driver to remove their self-registered vehicle first.`
- `Please remove your vehicle from the previous vendor first.`
- `Please remove the driver's existing vehicle first.`
- `Only the original vendor can remove this vehicle`
- `Only the vendor can remove the vehicle for a vendor-registered driver`

## Routes Added Or Updated

### Vendor routes

- `GET /vendor/drivers/:id`
  - default: self-registered + logged-in vendor's drivers
  - supports:
    - `?vendorName=<name>`
    - `?selfRegistered=true`
    - existing vehicle status filters

- `PATCH /vendor/drivers/:driverId/fleet-vehicle`
  - can target drivers across vendors
  - blocks assignment until old vehicle state is cleared by the correct owner

- `DELETE /vendor/drivers/:driverId/vehicle`
  - removes vehicle state for a driver
  - only allowed for the original vendor that owns that vehicle context

- `POST /vendor/assign-driver`
  - now blocked if the driver still has vehicle state that must be cleared first

- `DELETE /vendor/remove-driver/:driverId/:vendorId`
  - now blocked if the driver still has vehicle state

### Driver routes

- `DELETE /drivers/:id/vehicle`
  - requires driver auth
  - only works for self-registered drivers
  - vendor-created drivers are blocked from deleting their own vehicle

## Route Details

### 1. Vendor Driver List

**Route**

`GET /vendor/drivers/:id`

**Auth**

- Vendor JWT required

**Purpose**

- Returns the vendor driver list with access-aware filtering

**Query params**

- `vendorName`
  - filters only drivers assigned to the matched vendor business name
- `selfRegistered=true`
  - filters only self-registered drivers
- `vehiclePending=true`
  - existing vehicle pending filter
- `vehicleStatus=UNDER_APPROVAL|REJECTED|APPROVED|NOT_ADDED`
  - existing vehicle status filter

**Default behavior**

- Shows:
  - self-registered drivers
  - drivers under the logged-in vendor

**Response fields added**

- `vendor`
- `registrationType`

### 2. Assign Driver To Vendor

**Route**

`POST /vendor/assign-driver`

**Auth**

- Vendor JWT required

**Body**

```json
{
  "driverId": "DRIVER_ID",
  "vendorId": "VENDOR_ID"
}
```

**Purpose**

- Assigns a driver to the authenticated vendor

**Rules**

- Vendor can assign only to their own vendor account
- If the driver still has vehicle state:
  - self-registered vehicle: blocked
  - previous vendor vehicle: blocked
  - current vehicle state under current vendor: blocked

**Possible blocking messages**

- `Please ask the driver to remove their self-registered vehicle first.`
- `Please remove your vehicle from the previous vendor first.`
- `Please remove the driver's existing vehicle first.`

### 3. Assign Fleet Vehicle To Driver

**Route**

`PATCH /vendor/drivers/:driverId/fleet-vehicle`

**Auth**

- Vendor JWT required

**Body**

```json
{
  "fleetVehicleId": "FLEET_VEHICLE_ID"
}
```

**Purpose**

- Assigns an approved fleet vehicle to a driver

**Important behavior**

- Vendor can target drivers outside their own vendor scope
- Assignment is blocked until previous vehicle state is removed by the correct owner
- If assignment succeeds:
  - driver gets reassigned to the current vendor
  - old vendor totals are decremented when needed
  - new vendor totals are incremented when needed

**Blocking messages**

- `Please ask the driver to remove their self-registered vehicle first.`
- `Please remove your vehicle from the previous vendor first.`
- `Please remove the driver's existing vehicle first.`

### 4. Vendor Deletes Driver Vehicle

**Route**

`DELETE /vendor/drivers/:driverId/vehicle`

**Auth**

- Vendor JWT required

**Purpose**

- Removes all driver vehicle state from vendor side

**What gets removed**

- `vehicleInfo`
- `pendingVehicleInfo`
- `assignedFleetVehicleId`

**Rules**

- Only original vendor can remove a vendor-owned vehicle
- New vendor cannot remove a previous vendor's vehicle
- Vendor cannot remove self-registered vehicle on behalf of self-registered driver

**Possible error messages**

- `No vehicle found for this driver`
- `Self-registered drivers must remove their own vehicle`
- `Only the original vendor can remove this vehicle`

### 5. Driver Deletes Own Vehicle

**Route**

`DELETE /drivers/:id/vehicle`

**Auth**

- Driver JWT required
- driver must match `:id`

**Purpose**

- Allows only self-registered drivers to remove their own vehicle

**What gets removed**

- `vehicleInfo`
- `pendingVehicleInfo`
- `assignedFleetVehicleId`

**Rules**

- Works only when `driver.vendorId` is `null`
- Vendor-created drivers are blocked

**Possible error messages**

- `No vehicle found for this driver`
- `Only the vendor can remove the vehicle for a vendor-registered driver`

### 6. Remove Driver From Vendor

**Route**

`DELETE /vendor/remove-driver/:driverId/:vendorId`

**Auth**

- Vendor JWT required

**Purpose**

- Removes driver from vendor only after vehicle state is cleared

**Blocking message**

- `Please remove the driver vehicle first before removing this driver from the vendor`

## Main Files Changed

- `Controllers/Vendor/vendor.controller.js`
- `Controllers/Driver/driver.controller.js`
- `routes/Vendor/vendor.routes.js`
- `routes/Driver/driver.routes.js`

## Behavior Summary

### Vendor driver list behavior

- Default list shows:
  - self-registered drivers
  - drivers under the logged-in vendor
- `vendorName` filter shows:
  - only drivers for the matched vendor
- `selfRegistered=true` shows:
  - only drivers with no `vendorId`

Response additions:

- `vendor`
- `registrationType`

`registrationType` values:

- `SELF_REGISTERED`
- `VENDOR_ASSIGNED`

### Vehicle deletion behavior

Self-registered driver:

- can delete own vehicle using driver token

Vendor-created driver:

- cannot delete own vehicle
- vendor must delete it

Original vendor:

- can delete vehicle state for their driver or their vendor-owned assignment

New vendor:

- cannot delete the previous vendor's vehicle state
- gets blocked with:
  - `Please remove your vehicle from the previous vendor first.`

## Postman Test Checklist

### Driver visibility

1. Default vendor list
   - `GET /vendor/drivers/:id`
   - expect:
     - self-registered drivers
     - logged-in vendor drivers
     - not other vendors' drivers

2. Vendor name filter
   - `GET /vendor/drivers/:id?vendorName=<vendor business name>`
   - expect:
     - only that vendor's drivers

3. Self-registered filter
   - `GET /vendor/drivers/:id?selfRegistered=true`
   - expect:
     - only self-registered drivers

### Vehicle workflow

4. Self-registered driver removes own vehicle
   - `DELETE /drivers/:id/vehicle`
   - use driver token
   - expect success only when `vendorId` is `null`

5. Vendor-created driver tries to remove own vehicle
   - `DELETE /drivers/:id/vehicle`
   - use driver token
   - expect `403`

6. Original vendor removes vehicle
   - `DELETE /vendor/drivers/:driverId/vehicle`
   - use original vendor token
   - expect success

7. New vendor tries to assign before old vehicle removal
   - `PATCH /vendor/drivers/:driverId/fleet-vehicle`
   - expect:
     - `Please remove your vehicle from the previous vendor first.`

8. Vendor tries to assign to self-registered driver with existing own vehicle
   - `PATCH /vendor/drivers/:driverId/fleet-vehicle`
   - expect:
     - `Please ask the driver to remove their self-registered vehicle first.`

9. After vehicle removal, assign fleet vehicle
   - `PATCH /vendor/drivers/:driverId/fleet-vehicle`
   - expect success

## Verification Performed

Syntax checks completed successfully:

- `node --check Controllers\Vendor\vendor.controller.js`
- `node --check Controllers\Driver\driver.controller.js`
- `node --check routes\Vendor\vendor.routes.js`
- `node --check routes\Driver\driver.routes.js`

## Notes

- End-to-end API execution was not run from this session.
- The implemented logic is ready for Postman validation.
