# All Vehicle Routes Report

This document covers the full vehicle-related API surface in the current backend.

It includes:

- self driver vehicle routes
- vendor fleet vehicle routes
- vehicle approval routes
- vendor driver-to-vehicle assignment routes
- admin all-vehicle inventory routes

## Overview

There are **2 vehicle sources** in the system:

1. **Self Driver Vehicle**
   Stored on the driver document in:
   - `vehicleInfo` for approved vehicle
   - `pendingVehicleInfo` for under-approval or rejected vehicle submission

2. **Vendor Fleet Vehicle**
   Stored as separate `FleetVehicle` documents.
   A vendor driver may be linked to one fleet vehicle through:
   - `assignedFleetVehicleId`

## Vehicle Status Values

- `NOT_ADDED`
- `UNDER_APPROVAL`
- `APPROVED`
- `REJECTED`

## Vehicle Type Values

- `cercaGlide`
- `cercaTitan`
- `cercaZip`
- `auto`

## Authentication Summary

- Driver routes use driver authentication where enforced by route/controller.
- **`PATCH /drivers/:id/vehicle`**, **`PATCH /drivers/:id/vehicles/active`**, **`DELETE /drivers/:id/vehicles/:vehicleId`**, and **`DELETE /drivers/:id/vehicle`** require a **driver JWT** and the authenticated driver must match `:id`.
- Vendor routes require vendor JWT after `router.use(authenticateVendor)`.
- Admin routes require admin JWT.

## 1. Driver Vehicle Routes

Base path: `/drivers`

### 1.1 Submit or Update Driver Vehicle

**Method:** `PATCH`  
**Path:** `/:id/vehicle`

**Purpose:**  
Driver submits a **new** vehicle row (pushed to `vehicles[]`) with mandatory documents for approval.

**Content-Type:** `multipart/form-data`

**Text fields:**

- `make`
- `model`
- `year`
- `color`
- `licensePlate`
- `vehicleType`

**File fields:**

- `vehicleRc`
- `vehicleInsurance`
- `vehiclePermit`
- `vehiclePuc`

**Behavior:**

- If driver has no vendor, approval is routed to admin.
- If driver belongs to a vendor, approval is routed to vendor first.
- **Garage limits:** at most `MAX_DRIVER_OWNED_VEHICLES` entries (default **5**, env `MAX_DRIVER_OWNED_VEHICLES`).
- **Duplicate plate:** same normalized plate cannot be submitted while another entry is `APPROVED` or `UNDER_APPROVAL`.
- **Phase A pending:** only one `UNDER_APPROVAL` owned vehicle at a time; a second submission is rejected until the first is approved or rejected.
- Legacy **`vehicleInfo`** is kept in sync with the **active** approved owned vehicle (or fallback) via `syncLegacyVehicleState`; **`pendingVehicleInfo`** mirrors the pending/rejected row used for admin/vendor queues.

**Success response highlights:**

- `message`
- `routedTo`
- `approvedVehicle`
- `pendingVehicle`
- `vehicleStatus`
- `vehicles` (full garage list)
- `activeVehicleId`

### 1.1a Set active owned vehicle (self drivers)

**Method:** `PATCH`  
**Path:** `/:id/vehicles/active`

**Auth:** Driver JWT, own `:id`.

**Body (JSON):**

```json
{ "vehicleId": "<vehicles subdocument _id>" }
```

**Rules:** Target subdoc must be `APPROVED`. Forbidden for vendor drivers / when `assignedFleetVehicleId` is set. Exactly one owned subdoc ends with `isActive: true`; `vehicleInfo` is synced after save.

### 1.1b Remove one owned vehicle from garage

**Method:** `DELETE`  
**Path:** `/:id/vehicles/:vehicleId`

**Auth:** Driver JWT, own `:id`.

Removes the subdoc. If it was the active approved vehicle, another approved vehicle (if any) becomes active; legacy fields are synced.

### 1.2 Get Driver Details Including Vehicle State

**Method:** `GET`  
**Path:** `/:id`

**Purpose:**  
Returns the driver record, including current vehicle state.

**Important response fields:**

- `vehicleInfo` (legacy snapshot of active owned vehicle when not on fleet)
- `pendingVehicleInfo`
- `vehicleStatus`
- `vehicles` (garage subdocuments)
- `activeVehicleId`
- `assignedFleetVehicleId`
- `vendorId`

### 1.3 Get Driver Documents

**Method:** `GET`  
**Path:** `/:id/documents`

**Purpose:**  
Returns uploaded driver documents. Useful when checking compliance alongside vehicle data.

## 2. Vendor Routes For Vendor Driver Vehicle Approval

Base path: `/vendor`

These routes are for a vendor reviewing a **vendor-linked driver's personal vehicle submission**, not the vendor's fleet vehicles.

### 2.1 Approve Vendor Driver Vehicle

**Method:** `PATCH`  
**Path:** `/drivers/:driverId/vehicle/approve`

**Purpose:**  
Vendor approves a vendor-linked driver's submitted vehicle so it can continue in the workflow toward admin approval.

### 2.2 Reject Vendor Driver Vehicle

**Method:** `PATCH`  
**Path:** `/drivers/:driverId/vehicle/reject`

**Purpose:**  
Vendor rejects a vendor-linked driver's submitted vehicle.

**Body:**

```json
{
  "reason": "Document is unclear"
}
```

## 3. Vendor Fleet Vehicle Routes

Base path: `/vendor`

These routes manage the vendor's own fleet vehicles.

### 3.1 Create Fleet Vehicle

**Method:** `POST`  
**Path:** `/fleet-vehicles`

**Purpose:**  
Create a vendor-owned fleet vehicle and send it for admin approval.

**Content-Type:** `multipart/form-data`

**Text fields:**

- `make`
- `model`
- `year`
- `color`
- `licensePlate`
- `vehicleType`

**File fields:**

- `vehicleRc`
- `vehicleInsurance`
- `vehiclePermit`
- `vehiclePuc`

**Response highlights:**

- `success`
- `message`
- `fleetVehicle`

### 3.2 List Vendor Fleet Vehicles

**Method:** `GET`  
**Path:** `/fleet-vehicles`

**Purpose:**  
Returns all fleet vehicles belonging to the authenticated vendor.

### 3.3 Get Single Vendor Fleet Vehicle

**Method:** `GET`  
**Path:** `/fleet-vehicles/:id`

**Purpose:**  
Returns one fleet vehicle belonging to the authenticated vendor.

### 3.4 Resubmit Rejected Fleet Vehicle

**Method:** `POST`  
**Path:** `/fleet-vehicles/:id/resubmit`

**Purpose:**  
Resubmit a rejected fleet vehicle if admin allowed re-upload.

**Content-Type:** `multipart/form-data`

**Rules:**

- vehicle must be `REJECTED`
- `allowDocumentResubmit` must be `true`

## 4. Vendor Driver To Fleet Vehicle Assignment

Base path: `/vendor`

### 4.1 Assign Fleet Vehicle To Vendor Driver

**Method:** `PATCH`  
**Path:** `/drivers/:driverId/fleet-vehicle`

**Purpose:**  
Assign one approved vendor fleet vehicle to a vendor-linked driver.

**Body:**

```json
{
  "fleetVehicleId": "FLEET_VEHICLE_OBJECT_ID"
}
```

**Rules:**

- driver must belong to that vendor
- driver must already be admin-approved
- fleet vehicle must belong to that vendor
- fleet vehicle must be `APPROVED`

**Unassign behavior:**  
Send `fleetVehicleId` as empty string, null, or omit it to remove assignment.

## 5. Admin Routes For Driver Personal Vehicle Approval

Base path: `/admin`

These routes are for driver personal vehicles, mainly standalone driver submissions or admin-stage review.

### 5.1 List Drivers With Vehicle State

**Method:** `GET`  
**Path:** `/drivers`

**Purpose:**  
Admin can inspect drivers and filter by vehicle workflow state.

**Useful query params:**

- `vehiclePending=true`
- `vehicleStatus=UNDER_APPROVAL`
- `vehicleStatus=APPROVED`
- `vehicleStatus=REJECTED`
- `vehicleStatus=NOT_ADDED`
- `includeVendor=true`

### 5.2 Get Driver Details

**Method:** `GET`  
**Path:** `/drivers/:id`

**Purpose:**  
Returns driver details including:

- `vehicleInfo`
- `pendingVehicleInfo`
- `vehicleStatus`

### 5.3 Approve Driver Vehicle

**Method:** `PATCH`  
**Path:** `/drivers/:id/vehicle/approve`

**Purpose:**  
Admin approves the driver's pending vehicle submission.

### 5.4 Reject Driver Vehicle

**Method:** `PATCH`  
**Path:** `/drivers/:id/vehicle/reject`

**Purpose:**  
Admin rejects the driver's pending vehicle submission.

**Body:**

```json
{
  "reason": "Insurance document expired",
  "allowDocumentResubmit": true
}
```

### 5.5 Approve driver vehicle by garage subdocument id

**Method:** `PATCH`  
**Path:** `/drivers/:id/vehicles/:vehicleId/approve`

**Purpose:**  
Approves the specific `vehicles[]` entry that is `UNDER_APPROVAL` and routed to `ADMIN` (supports multiple pending rows in Phase B). Legacy `PATCH .../vehicle/approve` remains for the usual single-pending queue.

### 5.6 Reject driver vehicle by garage subdocument id

**Method:** `PATCH`  
**Path:** `/drivers/:id/vehicles/:vehicleId/reject`

**Purpose:**  
Rejects that specific pending admin-routed submission. Same body shape as **5.4**.

## 6. Admin Routes For Vendor Fleet Vehicles

Base path: `/admin/fleet-vehicles`

### 6.1 List Fleet Vehicles

**Method:** `GET`  
**Path:** `/`

**Purpose:**  
Returns vendor fleet vehicles for admin review.

**Query params:**

- `status`
- `vendorId`

**Response highlights:**

- `fleetVehicles[]`
- `vendor`
- `assignedDriver`
- `assignedDriverCount`

### 6.2 Get Single Fleet Vehicle

**Method:** `GET`  
**Path:** `/:id`

**Purpose:**  
Returns one vendor fleet vehicle with vendor summary and assigned driver summary.

### 6.3 Approve Fleet Vehicle

**Method:** `PATCH`  
**Path:** `/:id/approve`

**Purpose:**  
Admin approves a pending vendor fleet vehicle.

### 6.4 Reject Fleet Vehicle

**Method:** `PATCH`  
**Path:** `/:id/reject`

**Purpose:**  
Admin rejects a pending vendor fleet vehicle.

**Body:**

```json
{
  "reason": "Permit document missing",
  "allowDocumentResubmit": true
}
```

## 7. Admin All Vehicles Inventory Routes

These are the routes for the requirement:  
view **all vehicles**, including vendor fleet vehicles and self-driver vehicles, with assigned driver and vendor details where applicable.

### 7.1 Generic Admin All Vehicles Route

**Method:** `GET`  
**Path:** `/admin/vehicles`

**Purpose:**  
Returns a merged vehicle inventory across:

- vendor fleet vehicles
- self driver personal vehicles
- self driver pending vehicle submissions
- self driver rejected vehicle submissions

### 7.2 Fleet Module Admin Inventory Route

**Method:** `GET`  
**Path:** `/admin/fleet-vehicles/inventory`

**Purpose:**  
Returns the same merged inventory as `/admin/vehicles`, exposed from the fleet vehicle module as well.

### 7.3 Supported Query Params For Both Inventory Routes

- `status`
- `vendorId`
- `search`
- `ownershipType`

### 7.4 Query Param Details

#### `status`

Supported values:

- `APPROVED`
- `UNDER_APPROVAL`
- `REJECTED`

Behavior:

- fleet vehicles are filtered by `approvalStatus`
- self driver vehicles are filtered from `vehicleInfo` and `pendingVehicleInfo`

#### `vendorId`

Filters vendor fleet vehicles by vendor id.

Note:

- self driver vehicles are standalone only, so they use `vendorId: null`
- passing `vendorId` mainly affects vendor fleet results

#### `search`

Searches across vehicle fields such as:

- `make`
- `model`
- `color`
- `licensePlate`
- `vehicleType`

For self driver vehicle inventory it also searches:

- driver `name`
- driver `email`
- driver `phone`

#### `ownershipType`

Supported values:

- `VENDOR_FLEET`
- `DRIVER_PERSONAL`

## 8. Inventory Response Shape

Inventory routes return:

```json
{
  "success": true,
  "totalVehicles": 10,
  "fleetVehicleCount": 6,
  "standaloneVehicleCount": 4,
  "vehicles": []
}
```

### 8.1 Vehicle Record Types

Each object inside `vehicles` contains:

- `vehicleRecordType: "VENDOR_FLEET"` for vendor fleet vehicles
- `vehicleRecordType: "DRIVER_PERSONAL"` for self driver vehicles

## 9. Sample Inventory Record Shapes

### 9.1 Vendor Fleet Vehicle Record

```json
{
  "_id": "fleet_vehicle_id",
  "vehicleRecordType": "VENDOR_FLEET",
  "fleetVehicleId": "fleet_vehicle_id",
  "vendorId": {
    "_id": "vendor_id",
    "businessName": "ABC Fleet",
    "ownerName": "Rahul Sharma",
    "email": "vendor@example.com",
    "phone": "9999999999"
  },
  "vendor": {
    "_id": "vendor_id",
    "businessName": "ABC Fleet",
    "ownerName": "Rahul Sharma",
    "email": "vendor@example.com",
    "phone": "9999999999",
    "address": "Delhi",
    "isVerified": true,
    "isActive": true
  },
  "make": "Maruti",
  "model": "Ertiga",
  "year": 2023,
  "color": "White",
  "licensePlate": "DL01AB1234",
  "vehicleType": "cercaTitan",
  "approvalStatus": "APPROVED",
  "assignedDriver": {
    "_id": "driver_id",
    "name": "Vendor Driver",
    "email": "driver@example.com",
    "phone": "8888888888",
    "isVerified": true,
    "isActive": true,
    "isOnline": false,
    "vendorId": "vendor_id"
  },
  "assignedDriverCount": 1
}
```

### 9.2 Self Driver Vehicle Record

```json
{
  "_id": "driver-vehicle-driver_id",
  "vehicleRecordType": "DRIVER_PERSONAL",
  "driverId": "driver_id",
  "fleetVehicleId": null,
  "make": "Hyundai",
  "model": "Aura",
  "year": 2022,
  "color": "Silver",
  "licensePlate": "MH12AB1234",
  "vehicleType": "cercaGlide",
  "documents": [
    {
      "documentType": "RC",
      "documentUrl": "https://api.example.com/uploads/driverDocuments/rc.jpg"
    }
  ],
  "approvalStatus": "UNDER_APPROVAL",
  "approvalRoutedTo": "ADMIN",
  "submittedAt": "2026-04-02T09:00:00.000Z",
  "approvedAt": null,
  "rejectedAt": null,
  "rejectionReason": null,
  "allowDocumentResubmit": false,
  "vendor": null,
  "assignedDriver": {
    "_id": "driver_id",
    "name": "Self Driver",
    "email": "selfdriver@example.com",
    "phone": "7777777777",
    "isVerified": true,
    "isActive": true,
    "isOnline": true,
    "vendorId": null
  },
  "assignedDriverCount": 1
}
```

## 10. Route Summary Table

| Area | Method | Path | Purpose |
|------|--------|------|---------|
| Driver | `PATCH` | `/drivers/:id/vehicle` | Submit or update driver vehicle for approval |
| Driver | `GET` | `/drivers/:id` | Get driver with vehicle state |
| Vendor | `PATCH` | `/vendor/drivers/:driverId/vehicle/approve` | Vendor approves vendor-driver vehicle |
| Vendor | `PATCH` | `/vendor/drivers/:driverId/vehicle/reject` | Vendor rejects vendor-driver vehicle |
| Vendor | `POST` | `/vendor/fleet-vehicles` | Create vendor fleet vehicle |
| Vendor | `GET` | `/vendor/fleet-vehicles` | List vendor fleet vehicles |
| Vendor | `GET` | `/vendor/fleet-vehicles/:id` | Get one vendor fleet vehicle |
| Vendor | `POST` | `/vendor/fleet-vehicles/:id/resubmit` | Resubmit rejected fleet vehicle |
| Vendor | `PATCH` | `/vendor/drivers/:driverId/fleet-vehicle` | Assign or unassign fleet vehicle to vendor driver |
| Admin | `GET` | `/admin/drivers` | List drivers with vehicle filters |
| Admin | `GET` | `/admin/drivers/:id` | Get driver details including vehicle state |
| Admin | `PATCH` | `/admin/drivers/:id/vehicle/approve` | Approve driver vehicle (legacy single-pending) |
| Admin | `PATCH` | `/admin/drivers/:id/vehicle/reject` | Reject driver vehicle (legacy single-pending) |
| Admin | `PATCH` | `/admin/drivers/:id/vehicles/:vehicleId/approve` | Approve specific owned vehicle subdoc |
| Admin | `PATCH` | `/admin/drivers/:id/vehicles/:vehicleId/reject` | Reject specific owned vehicle subdoc |
| Driver | `PATCH` | `/drivers/:id/vehicles/active` | Set active approved owned vehicle |
| Driver | `DELETE` | `/drivers/:id/vehicles/:vehicleId` | Remove one garage vehicle |
| Admin | `GET` | `/admin/fleet-vehicles` | List vendor fleet vehicles |
| Admin | `GET` | `/admin/fleet-vehicles/:id` | Get one vendor fleet vehicle |
| Admin | `PATCH` | `/admin/fleet-vehicles/:id/approve` | Approve fleet vehicle |
| Admin | `PATCH` | `/admin/fleet-vehicles/:id/reject` | Reject fleet vehicle |
| Admin | `GET` | `/admin/vehicles` | Get merged all-vehicle inventory |
| Admin | `GET` | `/admin/fleet-vehicles/inventory` | Get merged all-vehicle inventory |

## 11. Important Notes

- `GET /admin/vehicles` and `GET /admin/fleet-vehicles/inventory` return the same merged inventory.
- Self driver inventory is limited to standalone drivers with `vendorId: null`.
- Vendor fleet vehicles include vendor details and assigned driver details.
- Self driver vehicles include assigned driver details and `vendor: null`.
- For self drivers, pending and rejected submissions are read from `pendingVehicleInfo`.
- For vendor fleet vehicles, approval state is read from the `FleetVehicle` document.

## 12. Recommended Frontend Usage

- Use `GET /admin/vehicles` for the admin "All Vehicles" screen.
- Use `GET /admin/fleet-vehicles` if you only need vendor fleet vehicles.
- Use `GET /admin/drivers/:id` when opening a driver detail page and you want the full driver approval context.
- Use `GET /vendor/fleet-vehicles` for vendor-side fleet management screens.
