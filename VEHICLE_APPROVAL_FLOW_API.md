# Vehicle Approval Flow API

This document describes the complete backend flow for adding a driver vehicle with mandatory document upload and approval.

## Overview

Vehicle addition is no longer instant.

When a driver submits vehicle details, the following 4 documents are mandatory:

- Vehicle RC
- Vehicle Insurance
- Vehicle Permit
- Vehicle PUC

After submission:

- If the driver belongs to a vendor, the submission is first routed to the **vendor** (`approvalRoutedTo: VENDOR`). When the vendor approves in the vendor panel, the submission is **forwarded to admin** (`approvalRoutedTo: ADMIN`, still `UNDER_APPROVAL`); the vendor does **not** copy it into `vehicleInfo`.
- If the driver is standalone, the approval goes to Admin directly (`approvalRoutedTo: ADMIN`).
- Until final admin approval, the driver should see the vehicle status as `UNDER_APPROVAL` while pending.
- After **admin** approval, the vehicle becomes the driver's active `vehicleInfo` and the status becomes `APPROVED`.

**Vendor fleet (separate from per-driver vehicle):** vendors can register multiple **fleet vehicles** approved by admin; drivers get `assignedFleetVehicleId`. See [FLEET_VEHICLE_API.md](./FLEET_VEHICLE_API.md). Vendor-linked drivers may go online using that assignment or legacy `vehicleInfo` per server rules.

## Vehicle Status Values

The backend now exposes a `vehicleStatus` field in driver detail responses.

Possible values:

- `NOT_ADDED`
- `UNDER_APPROVAL`
- `APPROVED`
- `REJECTED`

## Vehicle Type Values

Allowed `vehicleType` values:

- `cercaGlide`
- `cercaTitan`
- `cercaZip`
- `auto`

## 1. Driver Submits Vehicle For Approval

### Route

`PATCH /drivers/:id/vehicle`

### Content Type

`multipart/form-data`

### Authentication

Use whatever driver authentication flow the app already uses for driver APIs.

### Form Data Fields

Text fields:

- `make`
- `model`
- `year`
- `color`
- `licensePlate`
- `vehicleType`

File fields:

- `vehicleRc`
- `vehicleInsurance`
- `vehiclePermit`
- `vehiclePuc`

### Sample Form Data

Text:

```json
{
  "make": "Maruti",
  "model": "Swift Dzire",
  "year": 2022,
  "color": "White",
  "licensePlate": "MH12AB1234",
  "vehicleType": "sedan"
}
```

Files:

- `vehicleRc`: file
- `vehicleInsurance`: file
- `vehiclePermit`: file
- `vehiclePuc`: file

### Success Response

```json
{
  "message": "Vehicle submitted for admin approval successfully",
  "routedTo": "ADMIN",
  "approvedVehicle": null,
  "pendingVehicle": {
    "make": "Maruti",
    "model": "Swift Dzire",
    "year": 2022,
    "color": "White",
    "licensePlate": "MH12AB1234",
    "vehicleType": "sedan",
    "documents": [
      {
        "documentType": "RC",
        "documentUrl": "https://api.example.com/uploads/driverDocuments/123-rc.jpg"
      },
      {
        "documentType": "INSURANCE",
        "documentUrl": "https://api.example.com/uploads/driverDocuments/123-insurance.jpg"
      },
      {
        "documentType": "PERMIT",
        "documentUrl": "https://api.example.com/uploads/driverDocuments/123-permit.jpg"
      },
      {
        "documentType": "PUC",
        "documentUrl": "https://api.example.com/uploads/driverDocuments/123-puc.jpg"
      }
    ],
    "approvalStatus": "UNDER_APPROVAL",
    "approvalRoutedTo": "ADMIN",
    "submittedAt": "2026-03-27T12:00:00.000Z",
    "approvedAt": null,
    "rejectedAt": null,
    "rejectionReason": null
  },
  "vehicleStatus": "UNDER_APPROVAL"
}
```

### Vendor Driver Success Response

Only `routedTo` and `approvalRoutedTo` change:

```json
{
  "message": "Vehicle submitted for vendor approval successfully",
  "routedTo": "VENDOR",
  "approvedVehicle": null,
  "pendingVehicle": {
    "approvalStatus": "UNDER_APPROVAL",
    "approvalRoutedTo": "VENDOR"
  },
  "vehicleStatus": "UNDER_APPROVAL"
}
```

### Validation Error Response

If any required file is missing:

```json
{
  "message": "Vehicle RC, Insurance, Permit, and PUC documents are required",
  "missingFields": [
    "vehiclePermit"
  ]
}
```

## 2. Driver Fetches Own Vehicle Status

### Route

`GET /drivers/:id`

### Purpose

Frontend should use this to decide whether to show:

- no vehicle added
- under approval
- approved vehicle
- rejected vehicle

### Sample Response Shape

```json
{
  "_id": "driver_id",
  "name": "Driver Name",
  "vehicleInfo": {
    "make": "Maruti",
    "model": "Swift Dzire",
    "year": 2022,
    "color": "White",
    "licensePlate": "MH12AB1234",
    "vehicleType": "sedan"
  },
  "pendingVehicleInfo": null,
  "vehicleStatus": "APPROVED"
}
```

Under approval example:

```json
{
  "_id": "driver_id",
  "vehicleInfo": null,
  "pendingVehicleInfo": {
    "make": "Maruti",
    "model": "Swift Dzire",
    "documents": [
      {
        "documentType": "RC",
        "documentUrl": "https://api.example.com/uploads/driverDocuments/123-rc.jpg"
      }
    ],
    "approvalStatus": "UNDER_APPROVAL",
    "approvalRoutedTo": "ADMIN"
  },
  "vehicleStatus": "UNDER_APPROVAL"
}
```

Rejected example:

```json
{
  "_id": "driver_id",
  "vehicleInfo": null,
  "pendingVehicleInfo": {
    "approvalStatus": "REJECTED",
    "approvalRoutedTo": "ADMIN",
    "rejectionReason": "Insurance document expired"
  },
  "vehicleStatus": "REJECTED"
}
```

## 3. Admin Views Driver Details

### Route

`GET /admin/drivers/:id`

### Purpose

Admin panel can use this to inspect the pending vehicle submission for standalone drivers.

### Important Fields

- `driver.vehicleInfo`
- `driver.pendingVehicleInfo`
- `driver.vehicleStatus`

## 4. Admin Approves Standalone Driver Vehicle

### Route

`PATCH /admin/drivers/:id/vehicle/approve`

### Body

```json
{}
```

### Success Response

```json
{
  "message": "Driver vehicle approved successfully",
  "approvedVehicle": {
    "make": "Maruti",
    "model": "Swift Dzire",
    "year": 2022,
    "color": "White",
    "licensePlate": "MH12AB1234",
    "vehicleType": "sedan"
  },
  "pendingVehicle": null,
  "vehicleStatus": "APPROVED"
}
```

### Possible Error

If the vehicle is vendor-routed:

```json
{
  "message": "This vehicle approval is routed to vendor"
}
```

## 5. Admin Rejects Standalone Driver Vehicle

### Route

`PATCH /admin/drivers/:id/vehicle/reject`

### Body

```json
{
  "reason": "RC image is not readable"
}
```

### Success Response

```json
{
  "message": "Driver vehicle rejected successfully",
  "approvedVehicle": null,
  "pendingVehicle": {
    "make": "Maruti",
    "model": "Swift Dzire",
    "approvalStatus": "REJECTED",
    "approvalRoutedTo": "ADMIN",
    "rejectedAt": "2026-03-27T12:15:00.000Z",
    "rejectionReason": "RC image is not readable"
  },
  "vehicleStatus": "REJECTED"
}
```

## 6. Vendor Views Driver Details

### Route

`GET /vendor/driver/:driverId`

### Authentication

Vendor token required.

### Purpose

Vendor panel can use this to inspect pending vehicle details and uploaded docs for its own drivers.

### Important Fields

- `vehicleInfo`
- `pendingVehicleInfo`
- `vehicleStatus`

## 7. Vendor Approves Vendor Driver Vehicle

### Route

`PATCH /vendor/drivers/:driverId/vehicle/approve`

### Authentication

Vendor token required.

### Body

```json
{}
```

### Success Response

```json
{
  "success": true,
  "message": "Driver vehicle approved successfully",
  "approvedVehicle": {
    "make": "Maruti",
    "model": "Swift Dzire",
    "year": 2022,
    "color": "White",
    "licensePlate": "MH12AB1234",
    "vehicleType": "sedan"
  },
  "pendingVehicle": null,
  "vehicleStatus": "APPROVED"
}
```

### Possible Error

If the vehicle is admin-routed:

```json
{
  "success": false,
  "message": "This vehicle approval is routed to admin"
}
```

## 8. Vendor Rejects Vendor Driver Vehicle

### Route

`PATCH /vendor/drivers/:driverId/vehicle/reject`

### Authentication

Vendor token required.

### Body

```json
{
  "reason": "Insurance document expired"
}
```

### Success Response

```json
{
  "success": true,
  "message": "Driver vehicle rejected successfully",
  "approvedVehicle": null,
  "pendingVehicle": {
    "approvalStatus": "REJECTED",
    "approvalRoutedTo": "VENDOR",
    "rejectionReason": "Insurance document expired"
  },
  "vehicleStatus": "REJECTED"
}
```

## Frontend Handling Notes

### Driver App

Use `vehicleStatus` to render UI:

- `NOT_ADDED`: show add vehicle form
- `UNDER_APPROVAL`: show submitted vehicle and badge `Under Approval`
- `APPROVED`: show approved vehicle as active
- `REJECTED`: show rejection reason and allow resubmission

### Important

The add vehicle API must be sent as `multipart/form-data`.
Do not send it as raw JSON.

### Exact File Keys Required

- `vehicleRc`
- `vehicleInsurance`
- `vehiclePermit`
- `vehiclePuc`

### Recommended Driver App Flow

1. Driver fills vehicle details
2. Driver uploads all 4 files
3. Call `PATCH /drivers/:id/vehicle`
4. Read `vehicleStatus`
5. Poll or refresh `GET /drivers/:id`
6. If approved, show vehicle as added
7. If rejected, show `pendingVehicleInfo.rejectionReason`

### Admin Panel Flow

1. Open driver details using `GET /admin/drivers/:id`
2. Read `driver.pendingVehicleInfo`
3. View uploaded document URLs
4. Approve with `PATCH /admin/drivers/:id/vehicle/approve`
5. Reject with `PATCH /admin/drivers/:id/vehicle/reject`

### Vendor Panel Flow

1. Open driver details using `GET /vendor/driver/:driverId`
2. Read `pendingVehicleInfo`
3. Approve with `PATCH /vendor/drivers/:driverId/vehicle/approve`
4. Reject with `PATCH /vendor/drivers/:driverId/vehicle/reject`

## Driver list filters (admin and vendor)

List endpoints include `vehicleStatus` on each driver. For **paginated** filtering, use query parameters.

### Admin: `GET /admin/drivers`

Optional query:

- `vehiclePending=true` — drivers with vehicle submission **under approval** routed to **admin** (`pendingVehicleInfo.approvalStatus=UNDER_APPROVAL` and `approvalRoutedTo=ADMIN`).
- `vehicleStatus` — one of `UNDER_APPROVAL`, `REJECTED`, `APPROVED`, `NOT_ADDED`. For `UNDER_APPROVAL` and `REJECTED`, results are limited to submissions routed to **admin** (standalone-driver queue).

`vehiclePending=true` is equivalent to `vehicleStatus=UNDER_APPROVAL` for the admin queue.

### Vendor: `GET /vendor/drivers/:vendorId`

Optional query:

- `vehiclePending=true` — drivers under vendor vehicle approval (`UNDER_APPROVAL` and `approvalRoutedTo=VENDOR`).
- `vehicleStatus` — same values as above; for `UNDER_APPROVAL` and `REJECTED`, results are limited to **vendor**-routed submissions.

## Quick Test Checklist

- Submit vehicle for standalone driver with all 4 docs
- Confirm route is marked `ADMIN`
- Submit vehicle for vendor driver with all 4 docs
- Confirm route is marked `VENDOR`
- Reject standalone driver vehicle and confirm `REJECTED`
- Approve standalone driver vehicle and confirm `APPROVED`
- Reject vendor driver vehicle and confirm `REJECTED`
- Approve vendor driver vehicle and confirm `APPROVED`
- Confirm frontend reads `vehicleStatus` from driver detail APIs
