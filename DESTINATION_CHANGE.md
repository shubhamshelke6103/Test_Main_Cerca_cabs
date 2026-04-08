# Destination change (rider mid-ride)

## API

- **Preview (no persist):** `GET /api/rides/:id/destination-quote?latitude=&longitude=`  
  Optional: `estimatedDuration` (minutes). Requires `Authorization: Bearer` (rider).

- **Apply:** `PATCH /api/rides/:id/destination`  
  Body JSON:
  - `dropoffLocation`: `{ type: 'Point', coordinates: [lng, lat] }`
  - `dropoffAddress` (optional)
  - `estimatedDuration` (optional)
  - `expectedRevision` (optional): must match current `ride.destinationRevision` or server returns `409`.

- **Limits:** `MIN_DESTINATION_MOVE_KM` = 0.05 (50 m); max `MAX_DESTINATION_CHANGES_PER_RIDE` = 15; rate limit 30 requests / 15 min / IP on quote + patch routes.

## Realtime

Server emits `rideDestinationUpdated` with `{ ride, pricing }` to the ride room, rider, driver, and admin.

## Payments (online / wallet / Razorpay)

- **Cash:** Updated `ride.fare` is the amount to collect at end of trip; driver and rider apps should reflect the latest fare from socket/API.
- **Prepaid / wallet / Razorpay:** Final settlement still runs at **trip completion** (see `recalculateRideFare` and payment controllers). If your product charges an **authorization at booking**, add an explicit capture or top-up flow for fare **increase**; the destination endpoint does **not** block on payment gateway success so riders are not stranded when the network is slow.

## Push (FCM)

Mobile push is not wired in this backend. **In-app** notifications are created (`Notification` model, type `ride_destination_updated`) for rider and driver. To add FCM, hook into the same place as `notifyDestinationChangeAsync` in `ride.controller.js` or a dedicated notification worker.
