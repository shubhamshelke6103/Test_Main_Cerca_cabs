# Driver Approval And Emergency Contact Flow

This document is for frontend integration.

It covers:
- Driver approval flow
- Vendor approval flow for vendor-linked drivers
- Required driver compliance documents
- Relevant API routes
- Emergency contact update flow

## Base Route Prefixes

- Driver routes: `/drivers`
- Vendor routes: `/vendor`
- Admin routes: `/admin`

## Approval Flow Summary

There are now 2 approval flows for drivers.

### 1. Independent Driver

This is a driver with no `vendorId`.

Flow:
1. Driver registers
2. Driver uploads/updates required compliance documents
3. Admin reviews the driver
4. Admin approves or rejects the driver

Approval state progression:
- `PENDING_ADMIN`
- `APPROVED` or `REJECTED`

### 2. Vendor-Linked Driver

This is a driver with a `vendorId`.

Flow:
1. Driver is created under vendor, or assigned to a vendor
2. Driver uploads/updates required compliance documents
3. Vendor performs initial approval
4. Request is forwarded to Admin
5. Admin performs final approval or rejection

Approval state progression:
- `PENDING_VENDOR`
- `PENDING_ADMIN`
- `APPROVED` or `REJECTED`

## Required Driver Documents For Approval

Before approval can succeed, the driver must have these compliance documents:

- `AADHAAR`
- `DRIVING_LICENSE`
- `PAN`

If any of these are missing, the approval API returns:
- `400 Bad Request`
- `missingDocuments` array

## Driver Approval Status Fields In API Responses

Driver list/detail APIs now include:

- `approvalStatus`
- `approvalWorkflow`

### `approvalStatus`

Possible values:
- `PENDING_VENDOR`
- `PENDING_ADMIN`
- `APPROVED`
- `REJECTED`

### `approvalWorkflow`

Shape:

```json
{
  "status": "PENDING_VENDOR",
  "routedTo": "VENDOR",
  "submittedAt": "2026-03-27T12:00:00.000Z",
  "vendorApprovedAt": null,
  "adminApprovedAt": null,
  "rejectedAt": null,
  "rejectedBy": null,
  "rejectionReason": null
}
```

Notes:
- `routedTo` can be `VENDOR`, `ADMIN`, or `null`
- `rejectedBy` can be `VENDOR`, `ADMIN`, or `null`

## Driver Registration And Profile Routes

### 1. Register Independent Driver

- Method: `POST`
- Route: `/drivers`
- Auth: No

Example body:

```json
{
  "name": "Rahul Kumar",
  "email": "rahul@example.com",
  "phone": "9876543210",
  "password": "1234",
  "location": {
    "type": "Point",
    "coordinates": [77.5946, 12.9716]
  }
}
```

Behavior:
- Creates an independent driver
- Initial approval state becomes `PENDING_ADMIN`

### 2. Create Driver Under Vendor

- Method: `POST`
- Route: `/vendor/drivers`
- Auth: Vendor JWT

Example body:

```json
{
  "vendorId": "VENDOR_ID",
  "name": "Amit Driver",
  "email": "amit@example.com",
  "phone": "9999999999",
  "password": "1234",
  "location": {
    "type": "Point",
    "coordinates": [77.5946, 12.9716]
  }
}
```

Behavior:
- Creates a vendor-linked driver
- Initial approval state becomes `PENDING_VENDOR`

### 3. Assign Existing Driver To Vendor

- Method: `POST`
- Route: `/vendor/assign-driver`
- Auth: Vendor JWT

Example body:

```json
{
  "driverId": "DRIVER_ID",
  "vendorId": "VENDOR_ID"
}
```

Behavior:
- Sets `vendorId`
- If driver is not already approved, approval state resets to `PENDING_VENDOR`

### 4. Remove Driver From Vendor

- Method: `DELETE`
- Route: `/vendor/remove-driver/:driverId/:vendorId`
- Auth: Vendor JWT

Behavior:
- Removes `vendorId`
- If driver is not already approved, approval state resets to `PENDING_ADMIN`

## Compliance Document Routes

Frontend should use these routes to update the typed compliance-document records used in approval.

### 1. Driver Updates Own Compliance Documents

- Method: `PUT`
- Route: `/drivers/:id/compliance-documents`
- Auth: Current implementation does not enforce driver JWT on this route in `driver.routes.js`

Body:

```json
{
  "complianceDocuments": [
    {
      "documentType": "AADHAAR",
      "documentNumber": "123412341234",
      "expiryDate": "2030-12-31T00:00:00.000Z",
      "verifiedAt": "2026-03-27T00:00:00.000Z",
      "notes": "Front image verified"
    },
    {
      "documentType": "DRIVING_LICENSE",
      "documentNumber": "DL-0420110149646",
      "expiryDate": "2030-12-31T00:00:00.000Z"
    },
    {
      "documentType": "PAN",
      "documentNumber": "ABCDE1234F",
      "expiryDate": "2030-12-31T00:00:00.000Z"
    }
  ]
}
```

Notes:
- `status` is auto-calculated by backend
- `documentType` is matched leniently by backend, but frontend should send canonical values:
  - `AADHAAR`
  - `DRIVING_LICENSE`
  - `PAN`

### 2. Vendor Updates Compliance Documents For Their Driver

- Method: `PUT`
- Route: `/vendor/drivers/:driverId/compliance-documents`
- Auth: Vendor JWT

Body is the same as above.

### 3. Admin Updates Compliance Documents For Any Driver

- Method: `PUT`
- Route: `/admin/drivers/:id/compliance-documents`
- Auth: Admin JWT

Body is the same as above.

## Approval Action Routes

### Vendor Initial Approval

- Method: `PATCH`
- Route: `/vendor/verify-driver`
- Auth: Vendor JWT

Body:

```json
{
  "driverId": "DRIVER_ID"
}
```

Behavior:
- Only works for drivers under the logged-in vendor
- Requires `AADHAAR`, `DRIVING_LICENSE`, and `PAN`
- Does not set final approval
- Moves status:
  - from `PENDING_VENDOR`
  - to `PENDING_ADMIN`

Success message:

```json
{
  "success": true,
  "message": "Driver verified by vendor and forwarded to admin for final approval"
}
```

### Vendor Rejection

- Method: `PATCH`
- Route: `/vendor/reject-driver`
- Auth: Vendor JWT

Body:

```json
{
  "driverId": "DRIVER_ID",
  "reason": "Documents are unclear"
}
```

Behavior:
- Only valid while driver is in `PENDING_VENDOR`
- Final state becomes `REJECTED`

### Admin Final Approval

- Method: `PATCH`
- Route: `/admin/drivers/:id/approve`
- Auth: Admin JWT

Behavior:
- For independent drivers:
  - approves directly from `PENDING_ADMIN`
- For vendor-linked drivers:
  - only works after vendor has already approved
  - approves from `PENDING_ADMIN`

Success result:
- `isVerified = true`
- `isActive = true`
- `approvalStatus = APPROVED`

### Admin Rejection

- Method: `PATCH`
- Route: `/admin/drivers/:id/reject`
- Auth: Admin JWT

Body:

```json
{
  "reason": "PAN document mismatch"
}
```

Behavior:
- Only valid while driver is in `PENDING_ADMIN`
- Final state becomes `REJECTED`

### Admin Verification Toggle Route

- Method: `PATCH`
- Route: `/admin/drivers/:id/verify`
- Auth: Admin JWT

Body:

```json
{
  "isVerified": true
}
```

Behavior:
- `true`:
  - behaves like final admin approval
  - still checks required documents
- `false`:
  - resets the driver back to pending approval
  - if vendor-linked: `PENDING_VENDOR`
  - if independent: `PENDING_ADMIN`

## Useful Driver Read Routes For Frontend

### Admin Driver List

- Method: `GET`
- Route: `/admin/drivers`
- Auth: Admin JWT

Useful response fields:
- `isVerified`
- `isActive`
- `vendorId`
- `approvalStatus`
- `approvalWorkflow`
- `rejectionReason`

### Admin Driver Details

- Method: `GET`
- Route: `/admin/drivers/:id`
- Auth: Admin JWT

### Vendor Driver List

- Method: `GET`
- Route: `/vendor/drivers/:id`
- Auth: Vendor JWT

Notes:
- `:id` here is the vendor id used by the existing route

### Vendor Driver Details

- Method: `GET`
- Route: `/vendor/driver/:driverId`
- Auth: Vendor JWT

### Driver Self Details

- Method: `GET`
- Route: `/drivers/:id`
- Auth: No route-level auth in current file

## Document File Routes

These are separate from typed `complianceDocuments`.

### Generic Driver Documents

- `POST /drivers/:id/documents`
- `PUT /drivers/:id/documents`
- `GET /drivers/:id/documents`
- `GET /admin/drivers/:id/documents`
- `GET /vendor/driver-document/:driverId`

### Vehicle Approval Documents

Driver vehicle submission route:

- Method: `PATCH`
- Route: `/drivers/:id/vehicle`

Required multipart fields:
- `vehicleRc`
- `vehicleInsurance`
- `vehiclePermit`
- `vehiclePuc`

Vehicle approval routes:
- `PATCH /vendor/drivers/:driverId/vehicle/approve`
- `PATCH /vendor/drivers/:driverId/vehicle/reject`
- `PATCH /admin/drivers/:id/vehicle/approve`
- `PATCH /admin/drivers/:id/vehicle/reject`

This vehicle approval flow is separate from driver approval flow.

## Emergency Contacts

Emergency contacts are stored on the driver as `trustedContacts`.

There is currently no separate add/delete emergency-contact endpoint.
Frontend should update the full `trustedContacts` array via the general driver update route.

### Update Emergency Contacts

- Method: `PUT`
- Route: `/drivers/:id`
- Auth: No route-level auth in current file

Body example:

```json
{
  "trustedContacts": [
    {
      "name": "Rohit Sharma",
      "relation": "Brother",
      "phone": "9876500001",
      "email": "rohit@example.com"
    },
    {
      "name": "Suman Devi",
      "relation": "Mother",
      "phone": "9876500002",
      "email": "suman@example.com"
    }
  ]
}
```

### Emergency Contact Rules

- Maximum allowed contacts: `5`
- If more than 5 contacts are sent, backend returns:

```json
{
  "message": "Driver can add up to 5 emergency contacts only"
}
```

Each contact supports:
- `name` required
- `relation` optional
- `phone` optional
- `email` optional

## Frontend Display Recommendations

### Show approval buttons based on `approvalStatus`

- `PENDING_VENDOR`
  - show vendor approve/reject buttons
  - admin should not show final approve yet

- `PENDING_ADMIN`
  - show admin approve/reject buttons
  - for vendor-linked drivers, show "Vendor approved, waiting for Admin"

- `APPROVED`
  - show approved state

- `REJECTED`
  - show rejected state and `approvalWorkflow.rejectionReason`

### Suggested labels

- `PENDING_VENDOR`: `Pending Vendor Review`
- `PENDING_ADMIN`: `Pending Admin Review`
- `APPROVED`: `Approved`
- `REJECTED`: `Rejected`

## Important Integration Note

Vendor driver approval is no longer final approval.

Old expectation:
- Vendor approves driver
- Driver becomes fully approved

New behavior:
- Vendor approves driver
- Request moves to Admin
- Admin completes final approval

Frontend should update button labels and status messaging accordingly.
