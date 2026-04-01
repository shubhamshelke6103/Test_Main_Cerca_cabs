# Fleet vehicle API (vendor-owned, admin-approved)

Vendors manage multiple fleet vehicles. Each vehicle has four documents (RC, Insurance, Permit, PUC). Admin gives final approval. Drivers are linked to one approved fleet vehicle via `assignedFleetVehicleId` on the driver record.

## Model summary

- **Unique** `(vendorId, licensePlate)` (plate stored uppercase).
- **Indexes**: `(vendorId, approvalStatus)`, unique compound on `(vendorId, licensePlate)`.
- **Statuses**: `UNDER_APPROVAL`, `APPROVED`, `REJECTED`.
- **Rejection**: `rejectionReason`, `allowDocumentResubmit` (admin may allow vendor resubmit).

## Vendor routes (JWT vendor)

Base path: `/vendor` (same auth as other vendor routes).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/fleet-vehicles` | Multipart: same fields as driver vehicle upload (`make`, `model`, `year`, `color`, `licensePlate`, `vehicleType`, files `vehicleRc`, `vehicleInsurance`, `vehiclePermit`, `vehiclePuc`). |
| GET | `/fleet-vehicles` | List this vendor’s vehicles. |
| GET | `/fleet-vehicles/:id` | Detail. |
| POST | `/fleet-vehicles/:id/resubmit` | When `REJECTED` and `allowDocumentResubmit`; multipart replaces documents and sets `UNDER_APPROVAL`. |

## Admin routes (JWT admin)

Base path: `/admin/fleet-vehicles`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Query: `status`, `vendorId`. Returns `{ success, fleetVehicles }`. |
| GET | `/:id` | Single vehicle (populated vendor summary). |
| PATCH | `/:id/approve` | Approve pending vehicle. |
| PATCH | `/:id/reject` | Body: `{ reason }` (required), `allowDocumentResubmit` (optional boolean). |

## Driver assignment (vendor)

- `PATCH /vendor/drivers/:driverId/fleet-vehicle`  
  Body: `{ fleetVehicleId: "<id>" }` to assign, or empty string / omit to unassign.  
  Rules: driver belongs to vendor; driver `isVerified` (admin-approved); fleet vehicle same vendor and `APPROVED`.

## Online / rides (vendor drivers)

Vendor-linked drivers need either an **approved assigned fleet vehicle** (validated in session service) or **legacy** approved `vehicleInfo` until fully migrated.

## Migration notes

- Existing vendor drivers may only have `vehicleInfo`. No automatic backfill; optionally create `FleetVehicle` records and assign, or leave on legacy path.
- After migration, rely on `assignedFleetVehicleId` + admin-approved fleet vehicle for eligibility.

## Auditing

Assign/unassign and admin approve/reject emit structured `logger.info` lines (vendorId, driverId / fleetVehicleId, adminId where relevant).
