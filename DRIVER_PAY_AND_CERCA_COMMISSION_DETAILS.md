# 🚕 Driver Pay Formula & Driver Payment to Cerca — Complete Documentation

This document explains in detail:
1. **Driver Pay Formula** (how much the driver earns and how much platform fee is charged).
2. **Driver Pay to Cerca** (how the driver pays Cerca when cash is collected, how net settlement works, and how Cerca collects its platform commission).
3. **Exact Codebase Implementation** (files, line numbers, endpoints, and database schemas).

---

## 1. 📐 Driver Pay Formula

### 1.1 The Active Production Formula

In the active codebase, the driver earnings and platform fee split is governed by **`utils/rideEarningsSplit.js`** through the function `computeRideEarningsSplit(grossFare)`:

```javascript
// Located in utils/rideEarningsSplit.js
function computeRideEarningsSplit (grossFare) {
  const g = Math.max(0, Number(grossFare) || 0)
  if (g <= 0) {
    return { platformFee: 0, driverEarning: 0, grossFare: 0 }
  }

  const platformFee = 5 + ((g - 100) / 100)
  const driverEarning = g - platformFee

  return {
    platformFee,
    driverEarning,
    grossFare: g
  }
}
```

### 1.2 Mathematical Breakdown of the Active Formula

$$\text{Platform Fee} = 5 + \frac{\text{Fare} - 100}{100}$$

Simplifying this equation:
$$\text{Platform Fee} = 5 + 0.01 \times \text{Fare} - 1 = 4 + 0.01 \times \text{Fare}$$

$$\text{Driver Earning} = \text{Fare} - \text{Platform Fee}$$

This means:
- **Base platform charge:** ₹4.00 flat.
- **Percentage platform fee:** 1% of the gross fare ($0.01 \times \text{Fare}$).
- **Driver Share:** 99% of the gross fare minus ₹4.00.

### 1.3 Examples Across Different Ride Fares

| Ride Gross Fare (₹) | Platform Fee to Cerca (₹) | Driver Earnings (₹) | Cerca Share % | Driver Share % |
| :--- | :--- | :--- | :--- | :--- |
| **₹50** | $5 + \frac{50-100}{100} = \mathbf{₹4.50}$ | $50 - 4.50 = \mathbf{₹45.50}$ | 9.0% | 91.0% |
| **₹100** | $5 + \frac{100-100}{100} = \mathbf{₹5.00}$ | $100 - 5.00 = \mathbf{₹95.00}$ | 5.0% | 95.0% |
| **₹200** | $5 + \frac{200-100}{100} = \mathbf{₹6.00}$ | $200 - 6.00 = \mathbf{₹194.00}$ | 3.0% | 97.0% |
| **₹500** | $5 + \frac{500-100}{100} = \mathbf{₹9.00}$ | $500 - 9.00 = \mathbf{₹491.00}$ | 1.8% | 98.2% |
| **₹1,000** | $5 + \frac{1000-100}{100} = \mathbf{₹14.00}$ | $1000 - 14.00 = \mathbf{₹986.00}$ | 1.4% | 98.6% |
| **₹2,000** | $5 + \frac{2000-100}{100} = \mathbf{₹24.00}$ | $2000 - 24.00 = \mathbf{₹1,976.00}$ | 1.2% | 98.8% |

*(Note: Tips paid by riders are 100% credited to the driver and are not split with the platform).*

---

### 1.4 Note on Legacy Settings-Based Percentage Model

In earlier documentation (`DRIVER_EARNINGS_CALCULATION.md`) and database settings schema (`Models/Admin/settings.modal.js`), there is a field for percentage split:
- `pricingConfigurations.platformFees`: 20%
- `pricingConfigurations.driverCommissions`: 80%

However, **all active runtime execution paths** across the backend explicitly import and invoke `computeRideEarningsSplit(grossFare)` from `utils/rideEarningsSplit.js`:
- `utils/socket.js` (lines 5117, 5143)
- `Controllers/Driver/driver.controller.js` (lines 3418–3456)
- `Controllers/Driver/earnings.controller.js` (lines 496–497)
- `Controllers/User/ride.controller.js` (lines 257, 1703, 1896)
- `utils/earningsValidator.js` (line 70)
- `utils/beforeStartCancelSettlement.js` (line 65)
- `utils/backfillEarnings.js` (line 262)

Both `getDriverEarnings` and `getDriverEarningsFormula` API endpoints return:
```json
"commission": {
  "platformFeeFormula": "5 + ((fare - 100) / 100)",
  "driverEarningFormula": "fare - platformFee"
}
```

---

## 2. 💳 How Driver Pays to Cerca

How the driver pays Cerca depends entirely on the **ride payment method**:

### 2.1 Scenario A: Digital Rides (WALLET, RAZORPAY, Online)
- Rider pays online upfront or at trip completion.
- Cerca's payment gateway or wallet balance captures the funds.
- Cerca already holds 100% of the money.
- Cerca keeps the `platformFee` directly.
- Cerca owes the driver: `driverEarning + tips`.
- **The driver does NOT owe Cerca anything for online rides.** Instead, Cerca owes the driver.

---

### 2.2 Scenario B: CASH Rides (Driver Owes Cerca)

When a ride is completed with payment method `CASH`:
1. The **rider pays 100% of the fare directly to the driver in physical cash**.
2. The driver now holds both:
   - Their own share (`driverEarning`)
   - **Cerca's platform fee (`platformFee`)**
3. When the driver marks cash as collected via:
   `PATCH /drivers/:driverId/rides/:rideId/mark-cash-collected`
4. The system creates a debt record in `AdminEarnings`:
   ```javascript
   cashPlatformReceivable: {
     amount: platformFee,        // Amount driver owes Cerca
     status: 'outstanding',      // Status is OUTSTANDING
     collectedAt: null,
     collectedBy: null
   }
   ```
5. `driverPayoutEligible` is set to `false` because the driver already collected their earnings in physical cash.

---

### 2.3 How Cerca Recovers / Collects the Owed Cash Fee from the Driver

The system implements two methods for recovering this money from the driver:

#### Method 1: Automatic Net Settlement Ledger (Automatic Deduction from Online Rides)
Implemented in **`utils/driverNetSettlementBalance.js`**:
The backend maintains a signed net ledger for every driver:

$$\text{Net Settlement Balance} = \text{Unpaid Online Earnings (+ Tips)} - \text{Outstanding Cash Owed to Cerca}$$

$$\text{Payoutable Amount} = \max(0, \text{Net Settlement Balance})$$

- When a driver completes online rides, Cerca owes them credit.
- When a driver completes cash rides, the driver owes Cerca commission.
- **The system automatically offsets the cash commission against the driver's online ride earnings!**
- If the driver tries to request a bank payout via `POST /api/drivers/:driverId/payout/request`, they can only withdraw `payoutableAmount`.
- If `Net Settlement Balance < 0`, the driver has a negative balance and cannot withdraw any money until online rides cover the debt or the cash is physically settled.

#### Method 2: Physical / Direct Admin Collection
When the driver pays the outstanding platform fee directly to Cerca (in cash at the office or via manual bank transfer):
- Admin calls:
  `PATCH /api/admin/drivers/earnings/:earningId/cash-platform-collect`
- This marks the record as settled:
  ```javascript
  earning.cashPlatformReceivable.status = 'settled';
  earning.cashPlatformReceivable.collectedAt = new Date();
  earning.cashPlatformReceivable.collectedBy = req.adminId;
  ```
- Once marked as `settled`, this amount is no longer deducted from the driver's net settlement balance.

#### Method 3: Direct Driver Online Payment via Razorpay (Fully Integrated)
Drivers can now pay Cerca directly from the Driver App via UPI, Card, Netbanking, etc.:
1. **Create Order:**
   `POST /drivers/:driverId/earnings/pay-cash-dues/create-order`
   - Body: `{ amount?: 100, earningId?: "id" }` (optional: pay full dues, specific amount, or specific ride)
   - Returns: `{ orderId, amount, currency: "INR", key: "..." }`
2. **Driver App completes Razorpay checkout:**
   Driver completes payment on device via UPI / Card / Netbanking.
3. **Verify Payment & Settle:**
   `POST /drivers/:driverId/earnings/pay-cash-dues/verify`
   - Body: `{ razorpay_order_id, razorpay_payment_id, razorpay_signature, earningId? }`
   - Validates cryptographic HMAC SHA-256 signature and Razorpay captured status.
   - Idempotently marks `cashPlatformReceivable.status = 'settled'`, sets `paymentMethod = 'RAZORPAY'`, and records `razorpayPaymentId`.
   - Distributes payment across outstanding dues in FIFO order (oldest rides first).
   - Emits real-time socket event `cashDuesSettled` to `driver_${driverId}`.

---

## 3. 🔍 Database Schema Reference (`AdminEarnings`)

File: `Models/Admin/adminEarnings.model.js`

| Field | Type | Description |
| :--- | :--- | :--- |
| `rideId` | `ObjectId` (Ref: Ride) | Unique reference to the completed ride |
| `driverId` | `ObjectId` (Ref: Driver) | Driver identifier |
| `riderId` | `ObjectId` (Ref: User) | Rider identifier |
| `grossFare` | `Number` | Total fare paid by rider (`ride.fare`) |
| `platformFee` | `Number` | Platform commission ($5 + \frac{\text{fare}-100}{100}$) |
| `driverEarning` | `Number` | Driver share ($\text{grossFare} - \text{platformFee}$) |
| `paymentMethodSnapshot` | `String` | `'CASH'`, `'WALLET'`, or `'RAZORPAY'` |
| `paymentStatus` | `String` | `'pending'`, `'completed'`, `'failed'`, `'refunded'` |
| `driverPayoutEligible` | `Boolean` | `true` for online rides; `false` for cash rides |
| `cashPlatformReceivable.amount` | `Number` | Amount driver owes platform on cash rides |
| `cashPlatformReceivable.status` | `String` | `'outstanding'`, `'settled'`, `'waived'` |
| `cashPlatformReceivable.paymentMethod` | `String` | `'MANUAL_CASH'`, `'RAZORPAY'`, or `'ONLINE_NETTED'` |
| `cashPlatformReceivable.razorpayOrderId` | `String` | Razorpay order ID |
| `cashPlatformReceivable.razorpayPaymentId` | `String` | Captured Razorpay transaction ID |
| `cashPlatformReceivable.collectedAt` | `Date` | Timestamp when fee was collected/settled |
| `cashPlatformReceivable.collectedBy` | `ObjectId` (Ref: Admin) | Admin user who collected fee (for manual cash) |

---

## 4. 🌐 Key API Endpoints Reference

### 4.1 Driver Earnings & Debt Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/drivers/:driverId/earnings` | Complete earnings dashboard: gross, driver share, platform fee, formulas, net settlement balance, and cash owed. |
| `GET` | `/drivers/:driverId/earnings/cash-owed-summary` | Summary of total cash platform fees owed by the driver to Cerca (`totalOutstanding` and ride list). |
| `POST` | `/drivers/:driverId/earnings/pay-cash-dues/create-order` | Create a Razorpay order for driver to pay outstanding cash dues online. |
| `POST` | `/drivers/:driverId/earnings/pay-cash-dues/verify` | Verify Razorpay payment signature and settle outstanding cash dues. |
| `GET` | `/drivers/:driverId/payout/available-balance` | Available bank payout balance after deducting outstanding cash platform fees (`netSettlementBalance`, `payoutableAmount`). |
| `POST` | `/drivers/:driverId/payout/request` | Request a bank payout (minimum ₹500 by default). |
| `PATCH` | `/drivers/:driverId/rides/:rideId/mark-cash-collected` | Driver marks cash collected from passenger; creates `outstanding` cash debt to Cerca. |

### 4.2 Admin Commission Collection Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/admin/drivers/cash-receivables` | List all outstanding cash platform fees owed by drivers to Cerca. |
| `PATCH` | `/api/admin/drivers/earnings/:earningId/cash-platform-collect` | Mark an outstanding cash platform fee as `settled` once driver pays Cerca. |
| `GET` | `/api/admin/drivers/earnings` | List all driver earnings records across the platform. |

---

## 5. 📂 Core Source Files Reference

1. **Earnings Split Formula:**
   - [`utils/rideEarningsSplit.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/utils/rideEarningsSplit.js#L5-L19)
2. **Ride Completion & Storing Earnings:**
   - [`utils/socket.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/utils/socket.js#L5114-L5195)
3. **Driver Cash Collection Handler:**
   - [`Controllers/Driver/driver.controller.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/Driver/driver.controller.js#L3015-L3120)
4. **Driver Net Settlement & Ledger (Cash Deduction):**
   - [`utils/driverNetSettlementBalance.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/utils/driverNetSettlementBalance.js#L26-L74)
5. **Driver Earnings Controller:**
   - [`Controllers/Driver/earnings.controller.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/Driver/earnings.controller.js#L11-L140)
6. **Cash Owed Summary Controller:**
   - [`Controllers/Driver/earnings.controller.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/Driver/earnings.controller.js#L614-L664)
7. **Admin Cash Collection Controller:**
   - [`Controllers/Admin/driverEarnings.controller.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/Admin/driverEarnings.controller.js#L567-L662)
8. **Admin Earnings Data Model:**
   - [`Models/Admin/adminEarnings.model.js`](file:///d:/Techlaps_pvt.ltd/test/Cerca-API/Models/Admin/adminEarnings.model.js#L3-L126)

