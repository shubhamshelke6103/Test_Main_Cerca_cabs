# Vendor Earning And Payout Flow

## Overview

Vendor earnings are now calculated only from `AdminEarnings` records whose `paymentStatus` is `completed`.

That means:

1. A ride must be completed.
2. The rider payment for that ride must be marked as completed.
3. The backend stores the driver earning inside `AdminEarnings`.
4. The vendor commission is calculated from that driver earning.
5. Only those completed commissions become eligible for vendor payout.

## Core Formula

The project uses this flow:

1. `grossFare` comes from the final ride fare.
2. `platformFee = grossFare * platformFees / 100`
3. `driverEarning = grossFare * driverCommissions / 100`
4. `vendorCommission` is calculated from `driverEarning`

Vendor commission logic:

- If `commissionType = PERCENTAGE`:
  `vendorCommission = driverEarning * commissionValue / 100`
- If `commissionType = FIXED`:
  `vendorCommission = min(commissionValue, driverEarning)`

## What Counts As Vendor Earnings

Only `AdminEarnings.paymentStatus = completed` is counted in:

- vendor earnings report
- driver-wise vendor earnings
- vendor available payout balance
- vendor dashboard balance/totals

Excluded from vendor earnings:

- `pending`
- `failed`
- `refunded`

## Data Sources

### Collections Used

- `Vendor`
- `Driver`
- `AdminEarnings`
- `VendorPayout`
- `Settings`

### Implementation Files In This Project

The current implementation lives in these existing project files:

- `Models/vendor/vendor.models.js`
- `Controllers/Vendor/vendor.controller.js`
- `Controllers/Admin/vendor.controller.js`
- `Routes/Vendor/vendor.routes.js`
- `Routes/Admin/vendor.routes.js`

Important:

- `VendorPayout` is registered from `Models/vendor/vendor.models.js`
- vendor earnings calculation helpers are currently inside `Controllers/Vendor/vendor.controller.js`
- admin-side vendor payout sync logic is currently inside `Controllers/Admin/vendor.controller.js`

### Important Fields

#### Vendor

- `commissionType`
- `commissionValue`
- `walletBalance`
- `totalEarnings`
- `bankAccount`

#### Driver

- `vendorId`

#### AdminEarnings

- `driverId`
- `grossFare`
- `platformFee`
- `driverEarning`
- `rideDate`
- `paymentStatus`

#### VendorPayout

- `vendor`
- `amount`
- `status`
- `relatedEarnings`
- `transactionReference`
- `processedBy`

## Current Backend Behavior

### Vendor Earnings Report

The report:

1. finds all drivers belonging to the logged-in vendor
2. loads only completed `AdminEarnings` for those drivers
3. calculates vendor commission for each earning
4. returns:
   - summary
   - driver-wise earnings
   - ride-wise revenue rows

### Vendor Wallet / Balance

Vendor wallet balance is the sum of completed vendor commissions that are not already reserved by a payout in one of these states:

- `PENDING`
- `PROCESSING`
- `COMPLETED`

If a payout becomes `FAILED` or `CANCELLED`, those earnings become available again.

### Vendor Payout Flow

1. Vendor updates bank account.
2. Vendor checks available balance.
3. Vendor requests payout.
4. System selects eligible completed earnings and links them in `relatedEarnings`.
5. Admin processes the payout.
6. Vendor balance is recalculated automatically.

### Vendor Dashboard Behavior

The vendor dashboard now syncs vendor financial fields before returning data.

That means these vendor fields are refreshed from completed earnings:

- `walletBalance`
- `totalEarnings`
- `totalRides`

The dashboard also returns extra payout-related metrics:

- `availableBalance`
- `paidOutAmount`
- `pendingPayoutAmount`
- `processingPayoutAmount`
- `eligibleEarningsCount`

## Vendor APIs

Base path in this project:

`/vendor`

All payout and earnings endpoints below require vendor JWT:

`Authorization: Bearer <vendor_access_token>`

---

## 1. Login Vendor

### Request

`POST /vendor/login`

```json
{
  "email": "vendor@example.com",
  "password": "your-password"
}
```

### Response

```json
{
  "message": "Login successful",
  "accessToken": "jwt-token",
  "vendor": {
    "id": "67f123...",
    "businessName": "ABC Fleet",
    "email": "vendor@example.com"
  }
}
```

---

## 2. Vendor Earnings Report

### Request

`GET /vendor/earnings-report`

Optional query params:

- `startDate=2026-03-01`
- `endDate=2026-03-31`

Example:

`GET /vendor/earnings-report?startDate=2026-03-01&endDate=2026-03-31`

### Response

```json
{
  "success": true,
  "data": {
    "vendor": {
      "id": "67f123...",
      "businessName": "ABC Fleet",
      "commissionType": "PERCENTAGE",
      "commissionValue": 10
    },
    "filters": {
      "startDate": "2026-03-01",
      "endDate": "2026-03-31",
      "paymentStatus": "completed"
    },
    "summary": {
      "totalGrossRevenue": 25000,
      "totalDriverEarnings": 20000,
      "totalVendorCommission": 2000,
      "totalPlatformFee": 5000,
      "rideCount": 82
    },
    "driverWiseEarnings": [
      {
        "driverId": "67d001...",
        "name": "Rahul",
        "phone": "9999999999",
        "email": "rahul@example.com",
        "rideCount": 25,
        "grossRevenue": 7600,
        "driverEarning": 6080,
        "vendorCommission": 608
      }
    ],
    "rideWiseRevenue": [
      {
        "earningId": "67e111...",
        "rideId": "67e222...",
        "rideDate": "2026-03-29T10:00:00.000Z",
        "driver": {
          "id": "67d001...",
          "name": "Rahul",
          "phone": "9999999999",
          "email": "rahul@example.com"
        },
        "pickupAddress": "A",
        "dropoffAddress": "B",
        "grossRevenue": 350,
        "platformFee": 70,
        "driverEarning": 280,
        "vendorCommission": 28,
        "vendorProfit": 28,
        "paymentStatus": "completed"
      }
    ]
  }
}
```

### Meaning Of Driver-Wise Earnings

`driverWiseEarnings` is the vendor-visible per-driver earning summary.

This is the part that lets a vendor see earnings for each driver under that vendor.

---

## 3. Vendor Available Balance

### Request

`GET /vendor/payout/available-balance`

### Response

```json
{
  "success": true,
  "data": {
    "availableBalance": 3200,
    "totalLifetimeEarnings": 6400,
    "paidOutAmount": 2500,
    "pendingPayoutAmount": 500,
    "processingPayoutAmount": 200,
    "minPayoutThreshold": 500,
    "canRequestPayout": true,
    "eligibleEarningsCount": 18,
    "completedEarningsCount": 42
  }
}
```

### Meaning

- `availableBalance`: completed vendor commission still available to withdraw
- `totalLifetimeEarnings`: all completed vendor commission till date
- `paidOutAmount`: already completed vendor payouts
- `pendingPayoutAmount`: payout requests waiting with admin
- `processingPayoutAmount`: payout requests under processing
- `eligibleEarningsCount`: completed earning rows still free for payout
- `completedEarningsCount`: all completed vendor earning rows

---

## 4. Request Vendor Payout

Vendor bank account must already be present on the vendor record.

### Request

`POST /vendor/payout/request`

```json
{
  "amount": 1500,
  "notes": "Weekly vendor payout"
}
```

### Response

```json
{
  "success": true,
  "message": "Vendor payout request submitted successfully. It will be processed within 1-3 business days.",
  "data": {
    "payout": {
      "id": "680001...",
      "amount": 1500,
      "status": "PENDING",
      "transactionReference": "VENDOR-PAYOUT-1743500000000-abc123",
      "requestedAt": "2026-04-01T10:00:00.000Z"
    },
    "earningsBreakdown": {
      "selectedEarnings": [
        {
          "earningId": "67e111...",
          "rideId": "67e222...",
          "driverId": "67d001...",
          "driverEarning": 280,
          "vendorCommission": 28,
          "rideDate": "2026-03-29T10:00:00.000Z"
        }
      ],
      "totalSelected": 1512
    }
  }
}
```

### Notes

- The payout amount must be less than or equal to `availableBalance`.
- Minimum threshold comes from `Settings.payoutConfigurations.minPayoutThreshold`.
- Only one vendor payout can remain in `PENDING` or `PROCESSING` at a time.
- The system links selected completed earning rows in `relatedEarnings`.
- If a payout is marked `FAILED` or `CANCELLED`, those linked earnings become available again.

---

## 5. Vendor Payout History

### Request

`GET /vendor/payout/history?page=1&limit=20`

Optional:

- `status=PENDING`
- `status=COMPLETED`

### Response

```json
{
  "success": true,
  "data": {
    "payouts": [],
    "pagination": {
      "currentPage": 1,
      "totalPages": 1,
      "totalPayouts": 0,
      "limit": 20
    },
    "statistics": {
      "totalPayoutAmount": 0,
      "totalPayouts": 0,
      "pendingAmount": 0,
      "pendingCount": 0
    }
  }
}
```

---

## 6. Vendor Payout Detail

### Request

`GET /vendor/payout/:payoutId`

### Response

```json
{
  "success": true,
  "data": {
    "payout": {
      "_id": "680001...",
      "vendor": "67f123...",
      "amount": 1500,
      "status": "PENDING",
      "relatedEarnings": [],
      "transactionReference": "VENDOR-PAYOUT-1743500000000-abc123"
    }
  }
}
```

---

## 7. Vendor Bank Account

Existing vendor bank account APIs are used for payout setup:

- `POST /vendor/:vendorId/bank-account`
- `GET /vendor/:vendorId/bank-account`
- `PUT /vendor/:vendorId/bank-account`
- `DELETE /vendor/:vendorId/bank-account`

Required bank fields:

- `accountNumber`
- `ifscCode`
- `accountHolderName`
- `bankName`
- optional `accountType`

## Admin APIs For Vendor Payouts

Base path:

`/admin/vendors`

These require admin authentication.

### List Vendor Payouts

`GET /admin/vendors/payouts?page=1&limit=20`

Optional filters:

- `status=PENDING`
- `vendorId=<vendorId>`

### Process Vendor Payout

`PATCH /admin/vendors/payouts/:id`

Example request:

```json
{
  "status": "COMPLETED",
  "transactionId": "BANK-TXN-123",
  "transactionReference": "UTR123456",
  "notes": "Transferred successfully"
}
```

Allowed statuses:

- `PROCESSING`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

## What Was Missing Before

Before this implementation:

- vendor report could include non-completed earnings
- vendor `walletBalance` and `totalEarnings` were not synchronized from real earnings
- vendor had no payout request/history/detail flow
- admin had no dedicated vendor payout processing endpoints

## What Is Implemented Now

- completed-only vendor earnings report
- vendor-visible driver-wise earnings
- vendor dashboard sync from actual completed earnings
- vendor available balance API
- vendor payout request API
- vendor payout history API
- vendor payout detail API
- admin list/process vendor payout APIs
- automatic vendor wallet and total earnings synchronization
