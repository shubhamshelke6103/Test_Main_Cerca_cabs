

## Scope Status

Completed BRD items:

1. Driver Ride Rejection Tracking
2. Live Location Sharing
3. Vendor Payment and Earnings Report
4. Driver Online Hours Tracking
5. Data Privacy in Ratings and Reviews
6. Compliance and Verification Alerts
7. Privacy Policy Implementation and Mandatory Acceptance During Registration


## Base Route Groups

- User: `/users`
- Driver: `/drivers`
- Ride: `/rides`
- Vendor: `/vendor`
- Driver Ratings: `/drivers`

## 1. Driver Ride Rejection Tracking

Status: Implemented

Frontend usage:

- This is mainly a display feature for driver/vendor/admin screens.
- Rejection counts are updated when a driver rejects ride requests in the socket flow.
- Frontend does not need a dedicated "increment" API for this BRD item.

Useful fields exposed by backend:

- `rideRejectionCount`
- `rideRejectionThreshold`

Relevant screens:

- Driver profile/details screen
- Vendor dashboard driver list
- Admin driver list/details

Useful routes:

### GET `/drivers/:id`

Purpose:
Fetch driver details including rejection metrics.

Expected useful fields in response:

- `rideRejectionCount`
- `rideRejectionThreshold`
- `isOnline`
- `isBusy`
- `isActive`
- `totalOnlineMinutes`

Frontend notes:

- Show count and threshold together, for example `3 / 5`.
- Threshold alert notifications are handled by backend flow; frontend can surface the returned count if available in profile APIs.

### GET `/vendor/dashboard/:vendorId`

Purpose:
Vendor dashboard summary, includes driver list with rejection count.

Useful fields from driver rows:

- `rideRejectionCount`
- `isOnline`
- `isActive`
- `isVerified`

## 2. Live Location Sharing

Status: Implemented

Supported flows:

1. Driver shares own live location
2. User/rider shares ride live location
3. Public shared-link access by token
4. Driver can share to vendor explicitly using `recipientType = vendor`

### Driver Live Location Routes

#### POST `/drivers/:id/live-location/share`

Purpose:
Create a live location share entry for a driver.

Request body:

```json
{
  "recipientName": "John",
  "recipientPhone": "9876543210",
  "recipientEmail": "john@example.com",
  "recipientType": "family",
  "relation": "brother",
  "durationMinutes": 120
}
```

Allowed `recipientType` values:

- `family`
- `vendor`
- `trusted_contact`

Vendor-specific behavior:

- If `recipientType` is `vendor`, backend auto-fetches the assigned vendor from the driver's `vendorId`.
- In that case frontend does not need to send `recipientName`.
- If the driver has no assigned vendor, backend returns `400`.

Recommended vendor share request:

```json
{
  "recipientType": "vendor",
  "durationMinutes": 120
}
```

Success response includes:

- `share.id`
- `share.recipientName`
- `share.recipientType`
- `share.relation`
- `share.expiresAt`
- `share.shareUrl`

Frontend notes:

- Use `shareUrl` directly for copy/share actions.
- Show countdown or expiry time using `expiresAt`.
- For vendor sharing, the UI can just show a simple "Share with Vendor" button.

#### GET `/drivers/:id/live-location/shares`

Purpose:
List previously created driver live-location shares.

Frontend notes:

- Use for a "shared with" history list.
- Useful fields include recipient details, active state, and expiry.

#### DELETE `/drivers/:id/live-location/share/:shareId`

Purpose:
Revoke an active driver live-location share.

Frontend notes:

- Call this when user taps "Stop sharing".
- After revoke, refresh the share list.

#### GET `/drivers/live-location/shared/:shareToken`

Purpose:
Public access route for a shared driver live-location token.

Frontend notes:

- No auth required.
- Must handle expired or invalid token response.

### Ride Live Location Routes

#### POST `/rides/:rideId/live-location/share`

Purpose:
User/rider shares current ride live location.

Request body:

```json
{
  "recipientName": "Jane",
  "recipientPhone": "9998887776",
  "recipientEmail": "jane@example.com",
  "recipientType": "trusted_contact",
  "relation": "friend",
  "durationMinutes": 180
}
```

Success response includes:

- `data.shareId`
- `data.shareUrl`
- `data.expiresAt`
- `data.recipientName`
- `data.recipientType`

Frontend notes:

- This is the main route for rider-side "Share Trip" flow.
- Backend checks that the logged-in user owns the ride.

#### GET `/rides/:rideId/live-location/shares`

Purpose:
List all live-location shares for the ride.

#### DELETE `/rides/:rideId/live-location/share/:shareId`

Purpose:
Revoke one ride live-location share.

#### GET `/rides/live-location/shared/:shareToken`

Purpose:
Public shared-link route for ride live location.

Frontend notes:

- No auth required.
- Handle expired share token gracefully.

### Existing Ride Share Link Routes

These are related but separate from live-location-share records:

#### POST `/rides/:rideId/share`

Purpose:
Generate ride share link.

#### DELETE `/rides/:rideId/share`

Purpose:
Revoke ride share link.

#### GET `/rides/shared/:shareToken`

Purpose:
Fetch public shared ride data by token.

#### GET `/rides/shared-ride/:shareToken`

Purpose:
Serve public shared ride tracking HTML page.

## 3. Vendor Payment and Earnings Report

Status: Implemented

### GET `/vendor/earnings-report`

Auth:
Vendor token required.

Purpose:
Vendor earnings report with summary, driver-wise earnings, and ride-wise revenue.

Optional query params:

- `startDate`
- `endDate`

Example:

```http
GET /vendor/earnings-report?startDate=2026-03-01&endDate=2026-03-31
```

Response structure:

- `data.vendor`
- `data.summary`
- `data.driverWiseEarnings`
- `data.rideWiseRevenue`

`data.vendor` fields:

- `id`
- `businessName`
- `commissionType`
- `commissionValue`

`data.summary` fields:

- `totalGrossRevenue`
- `totalDriverEarnings`
- `totalVendorCommission`
- `totalPlatformFee`
- `rideCount`

Each `driverWiseEarnings` item includes:

- `driverId`
- `name`
- `phone`
- `rideCount`
- `grossRevenue`
- `driverEarning`
- `vendorCommission`

Each `rideWiseRevenue` item includes:

- `earningId`
- `rideId`
- `rideDate`
- `driver`
- `pickupAddress`
- `dropoffAddress`
- `grossRevenue`
- `platformFee`
- `driverEarning`
- `vendorCommission`
- `vendorProfit`
- `paymentStatus`

Frontend notes:

- This route is enough for earnings dashboard, summary cards, driver table, and ride report table.
- Use date filters on frontend and pass query params.
- `vendorProfit` currently mirrors vendor commission logic in backend.

## 4. Driver Online Hours Tracking

Status: Implemented

### PATCH `/drivers/:id/online-status`

Purpose:
Toggle driver online/offline status.

Frontend notes:

- Backend tracks session start and stop behind this flow.
- Use this for the driver availability toggle.

### POST `/drivers/:id/logout`

Purpose:
Driver logout endpoint; also closes active online session.

### GET `/drivers/:id/online-hours`

Purpose:
Fetch online-hours report.

Supported query params:

- `period=daily`
- `period=weekly`
- `period=monthly`
- `startDate`
- `endDate`

Examples:

```http
GET /drivers/:id/online-hours?period=daily
GET /drivers/:id/online-hours?period=weekly
GET /drivers/:id/online-hours?period=monthly
GET /drivers/:id/online-hours?startDate=2026-03-01&endDate=2026-03-20&period=daily
```

Response structure:

- `success`
- `driver`
- `report`

`driver` fields:

- `id`
- `name`
- `totalOnlineMinutes`
- `currentOnlineSessionStartedAt`

`report` fields:

- `summary`
- `totalMinutes`
- `totalSessions`
- `period`
- `startDate`
- `endDate`

Each `summary` row includes:

- `period`
- `totalMinutes`
- `sessionCount`

Frontend notes:

- Convert `totalMinutes` into hours/minutes in UI.
- Use charts for daily/weekly/monthly views.
- `currentOnlineSessionStartedAt` can be used to show "currently online since" if not null.

## 5. Data Privacy in Ratings and Reviews

Status: Implemented

The backend masks personal details in rating responses.

### POST `/drivers/ratings`

Purpose:
Submit a rating.

Typical request body:

```json
{
  "rideId": "RIDE_ID",
  "ratedBy": "USER_OR_DRIVER_ID",
  "ratedByModel": "User",
  "ratedTo": "DRIVER_OR_USER_ID",
  "ratedToModel": "Driver",
  "rating": 5,
  "review": "Good trip",
  "tags": ["polite", "on_time"]
}
```

### GET `/drivers/ratings/:entityModel/:entityId`

Purpose:
Get all ratings for a user or driver.

Allowed `entityModel`:

- `Driver`
- `User`

Important privacy behavior:

- Returned `ratedBy.name` is masked
- Returned `ratedBy.phone` is masked
- Returned `ratedTo.name` is masked
- Returned `ratedTo.phone` is masked

Frontend notes:

- Do not expect full phone number or exact name in review lists.
- Design review UI for masked values like `J***n` or `******3210`.

### GET `/drivers/ratings/:entityModel/:entityId/stats`

Purpose:
Fetch rating summary.

Response fields:

- `averageRating`
- `totalRatings`
- `ratingDistribution`

### GET `/drivers/ratings/ride/:rideId`

Purpose:
Fetch rating records for a single ride.

## 6. Compliance and Verification Alerts

Status: Implemented

This BRD point is mostly backend-driven. Frontend work is mainly document management and status display.

Tracked document statuses:

- `valid`
- `expiring_soon`
- `expired`

### Driver Compliance Routes

#### PUT `/drivers/:id/compliance-documents`

Purpose:
Replace/update driver compliance documents.

Request body:

```json
{
  "complianceDocuments": [
    {
      "documentType": "PUC",
      "documentNumber": "PUC-12345",
      "expiryDate": "2026-04-30",
      "notes": "Uploaded by driver"
    }
  ]
}
```

Frontend notes:

- Backend calculates and stores status.
- Frontend should display status badges.
- Useful for driver profile document section.

#### PUT `/vendor/drivers/:driverId/compliance-documents`

Purpose:
Vendor updates compliance documents for one of its drivers.

### Vendor Compliance Routes

#### PUT `/vendor/compliance-documents`

Purpose:
Vendor updates its own compliance documents.

Frontend notes:

- Show expiry date clearly.
- Highlight `expiring_soon` and `expired`.
- Alerts are processed server-side, so frontend mainly needs document CRUD UI and status display.

## 7. Privacy Policy Implementation and Mandatory Acceptance During Registration

Status: Implemented

### GET `/users/privacy-policy`

Purpose:
Fetch current policy metadata for registration screen.

Response:

```json
{
  "success": true,
  "privacyPolicy": {
    "version": "2026-03-23",
    "url": "/privacy-policy"
  }
}
```

Frontend notes:

- Call this before rendering sign-up checkbox text if needed.
- Use `version` for tracking accepted policy version.
- Use `url` as privacy policy link target.

### POST `/users`

Purpose:
Create a new user.

Mandatory field for BRD compliance:

- `privacyPolicyAccepted: true`

Recommended request body:

```json
{
  "fullName": "Test User",
  "email": "testuser@example.com",
  "phoneNumber": "9876543210",
  "privacyPolicyAccepted": true
}
```

Optional fields now accepted:

- `privacyPolicyVersion`
- `privacyPolicyUrl`

Backend behavior:

- If `privacyPolicyAccepted` is missing or false, backend returns `400`.
- Backend stores:
  - `privacyPolicyAccepted`
  - `privacyPolicyAcceptedAt`
  - `privacyPolicyVersion`
  - `privacyPolicyUrl`

Frontend requirements:

- Registration UI must include a required privacy policy checkbox.
- Do not submit sign-up form until checkbox is checked.
- Keep the checkbox label linked to policy URL from `/users/privacy-policy`.

### POST `/users/login`

Purpose:
Mobile login.

Important behavior:

- Existing user login works as before.
- If phone number does not exist and backend auto-creates a new user, privacy policy acceptance is now required.

Recommended request body for new-number onboarding:

```json
{
  "phoneNumber": "9998887776",
  "privacyPolicyAccepted": true
}
```

Frontend notes:

- If this endpoint is used as combined login/register, the app must include privacy acceptance before first-time mobile login.
- Existing users do not need to re-accept at each login.

## Additional Helpful Routes

These are not direct BRD items, but frontend may need them on related screens.

### GET `/vendor/driver-location/:driverId`

Purpose:
Vendor fetches current location of an assigned driver.

Useful for:

- Vendor live tracking view
- Driver map preview

### GET `/vendor/drivers/:id`

Purpose:
Vendor fetches all drivers under the vendor.

Useful for:

- Vendor driver list
- Driver management screen

### GET `/vendor/driver/:driverId`

Purpose:
Vendor fetches one assigned driver in detail.

### GET `/drivers/:id/stats`

Purpose:
Driver stats screen support.

## Frontend Checklist

### User App

- Add required privacy policy checkbox on registration.
- Add required privacy policy checkbox or consent step for first-time mobile login.
- Add rider live location sharing UI.
- Add share-history UI for ride live location shares.
- Handle expired shared-link responses.

### Driver App

- Show driver rejection count and threshold in profile or dashboard.
- Add online/offline toggle using `/drivers/:id/online-status`.
- Add online-hours report screen using `/drivers/:id/online-hours`.
- Add compliance document upload/update screen.
- Add live location sharing UI with:
  - family
  - trusted contact
  - vendor quick-share

### Vendor App

- Add earnings dashboard using `/vendor/earnings-report`.
- Add compliance document management screen.
- Add driver list showing status and rejection count.
- Add driver location tracking screen using `/vendor/driver-location/:driverId`.

## Not Available in This Scope

- Hotspot area identification APIs are not implemented.
- Real email/SMS delivery status APIs are not included in this handoff.

## Suggested Postman Checks for Frontend Team

1. `GET /users/privacy-policy`
2. `POST /users` with `privacyPolicyAccepted: true`
3. `POST /users` without `privacyPolicyAccepted`
4. `POST /users/login` with a new phone number and `privacyPolicyAccepted: true`
5. `POST /drivers/:id/live-location/share` with `recipientType: vendor`
6. `GET /drivers/:id/online-hours?period=daily`
7. `GET /vendor/earnings-report`
8. `PUT /drivers/:id/compliance-documents`
9. `GET /drivers/ratings/:entityModel/:entityId`
