# 💰 Driver Earnings Calculation - Complete Guide

> **Cross-role overview:** For how admin, driver, and vendor earnings connect around `AdminEarnings` and `paymentStatus`, see [EARNINGS_SYSTEM.md](./EARNINGS_SYSTEM.md).

## Overview

The driver earnings calculation now uses the **Admin Settings** schema to properly calculate platform fees and driver commissions based on configurable pricing rules.

---

## 🔧 Configuration (Admin Settings)

### Settings Schema Fields Used:

```javascript
{
  pricingConfigurations: {
    platformFees: 20,        // Platform takes 20% of fare
    driverCommissions: 80,   // Driver gets 80% of fare
  }
}
```

### How to Set/Update Settings:

```javascript
// Example: Set platform fees to 20% and driver commission to 80%
await Settings.findOneAndUpdate(
  {},
  {
    $set: {
      'pricingConfigurations.platformFees': 20,
      'pricingConfigurations.driverCommissions': 80
    }
  },
  { new: true, upsert: true }
);
```

---

## 📊 Calculation Logic

### Formula:

```javascript
// For each completed ride:
Gross Fare = ride.fare (amount rider pays)

Platform Fee = Gross Fare × (platformFees / 100)
Driver Earning = Gross Fare × (driverCommissions / 100)

// Validation: platformFees + driverCommissions should = 100%
```

### Example Calculation:

**Settings:**
- Platform Fees: 20%
- Driver Commission: 80%

**Ride Example:**
- Ride Fare: ₹500

**Calculation:**
```javascript
Gross Fare = ₹500
Platform Fee = ₹500 × (20/100) = ₹100
Driver Earning = ₹500 × (80/100) = ₹400
```

**For 10 Completed Rides (₹500 each):**
```javascript
Total Gross Earnings = 10 × ₹500 = ₹5,000
Total Platform Fees = ₹5,000 × 20% = ₹1,000
Total Driver Earnings = ₹5,000 × 80% = ₹4,000

Average Gross Per Ride = ₹5,000 / 10 = ₹500
Average Net Per Ride = ₹4,000 / 10 = ₹400
```

---

## 🎯 API Endpoint

### Route:
```http
GET /api/drivers/:id/earnings
```

### Response Format:

```json
{
  "totalGrossEarnings": 50000,
  "totalPlatformFees": 10000,
  "totalDriverEarnings": 40000,
  "platformFeePercentage": 20,
  "driverCommissionPercentage": 80,
  "totalRides": 140,
  "averageGrossPerRide": "357.14",
  "averageNetPerRide": "285.71",
  "recentRides": [
    {
      "_id": "ride_id",
      "fare": 350,
      "platformFee": "70.00",
      "driverEarning": "280.00",
      "distanceInKm": 5.2,
      "actualDuration": 25,
      "pickupAddress": "123 Main St",
      "dropoffAddress": "456 Park Ave",
      "createdAt": "2024-01-15T10:00:00Z",
      "completedAt": "2024-01-15T10:25:00Z"
    }
    // ... up to 10 recent rides
  ]
}
```

---

## 📝 Response Fields Explained

| Field | Description |
|-------|-------------|
| `totalGrossEarnings` | Total fare collected from all completed rides |
| `totalPlatformFees` | Total amount deducted as platform commission |
| `totalDriverEarnings` | **Net amount driver receives** (what they take home) |
| `platformFeePercentage` | Platform commission percentage from settings |
| `driverCommissionPercentage` | Driver commission percentage from settings |
| `totalRides` | Number of completed rides |
| `averageGrossPerRide` | Average fare per ride (before commission) |
| `averageNetPerRide` | Average driver earning per ride (after commission) |
| `recentRides` | Last 10 completed rides with breakdown |

### Recent Rides Breakdown:

| Field | Description |
|-------|-------------|
| `fare` | Total fare for this ride |
| `platformFee` | Platform's cut for this ride |
| `driverEarning` | Driver's earning for this ride |
| `distanceInKm` | Distance traveled |
| `actualDuration` | Ride duration in minutes |
| `completedAt` | When ride was completed |

---

## 🔍 Usage Examples

### JavaScript/Node.js:
```javascript
const axios = require('axios');

async function getDriverEarnings(driverId) {
  const response = await axios.get(`http://localhost:3000/api/drivers/${driverId}/earnings`);
  const earnings = response.data;
  
  console.log(`Driver Net Earnings: ₹${earnings.totalDriverEarnings}`);
  console.log(`Platform Collected: ₹${earnings.totalPlatformFees}`);
  console.log(`Total Rides: ${earnings.totalRides}`);
  console.log(`Average Net Per Ride: ₹${earnings.averageNetPerRide}`);
  
  return earnings;
}
```

### curl:
```bash
curl http://localhost:3000/api/drivers/DRIVER_ID/earnings
```

### React Native (Driver App):
```javascript
import axios from 'axios';

const DriverEarnings = ({ driverId }) => {
  const [earnings, setEarnings] = useState(null);
  
  useEffect(() => {
    axios.get(`${API_URL}/drivers/${driverId}/earnings`)
      .then(response => {
        setEarnings(response.data);
      });
  }, [driverId]);
  
  if (!earnings) return <Loading />;
  
  return (
    <View>
      <Text>Total Earnings: ₹{earnings.totalDriverEarnings}</Text>
      <Text>Total Rides: {earnings.totalRides}</Text>
      <Text>Average per Ride: ₹{earnings.averageNetPerRide}</Text>
      
      <Text>Commission Rate: {earnings.driverCommissionPercentage}%</Text>
      <Text>Platform Fee: {earnings.platformFeePercentage}%</Text>
      
      <FlatList
        data={earnings.recentRides}
        renderItem={({ item }) => (
          <View>
            <Text>Fare: ₹{item.fare}</Text>
            <Text>Your Earning: ₹{item.driverEarning}</Text>
            <Text>{item.pickupAddress} → {item.dropoffAddress}</Text>
          </View>
        )}
      />
    </View>
  );
};
```

---

## 🎨 UI Display Examples

### Driver App - Earnings Dashboard

```
┌─────────────────────────────────────┐
│    💰 Your Earnings                 │
├─────────────────────────────────────┤
│                                     │
│  Total Earnings (Net)               │
│  ₹40,000                           │
│                                     │
│  Total Rides: 140                   │
│  Average per Ride: ₹285.71          │
│                                     │
├─────────────────────────────────────┤
│  📊 Breakdown                        │
├─────────────────────────────────────┤
│  Gross Collected:    ₹50,000        │
│  Platform Fee (20%): -₹10,000       │
│  Your Share (80%):   ₹40,000        │
└─────────────────────────────────────┘
```

### Recent Rides List

```
┌─────────────────────────────────────┐
│  📍 MG Road → Indiranagar          │
│  ₹350  →  Your Earning: ₹280       │
│  5.2 km • 25 min                    │
│  Jan 15, 10:00 AM                   │
├─────────────────────────────────────┤
│  📍 Koramangala → Whitefield       │
│  ₹520  →  Your Earning: ₹416       │
│  12.3 km • 35 min                   │
│  Jan 15, 11:30 AM                   │
└─────────────────────────────────────┘
```

---

## ⚙️ Configuration Best Practices

### Common Commission Models:

#### 1. **Standard Model (80/20)**
```javascript
{
  platformFees: 20,        // Platform takes 20%
  driverCommissions: 80    // Driver gets 80%
}
```
**Best for**: Established markets, competitive pricing

#### 2. **Driver-Friendly Model (85/15)**
```javascript
{
  platformFees: 15,        // Platform takes 15%
  driverCommissions: 85    // Driver gets 85%
}
```
**Best for**: Growing markets, driver acquisition

#### 3. **Premium Model (70/30)**
```javascript
{
  platformFees: 30,        // Platform takes 30%
  driverCommissions: 70    // Driver gets 70%
}
```
**Best for**: Premium services, high-value markets

### Dynamic Commission (Future Enhancement):
```javascript
// Example: Different rates for different service types
{
  services: [
    { name: 'Economy', driverCommission: 80 },
    { name: 'Premium', driverCommission: 75 },
    { name: 'Luxury', driverCommission: 70 }
  ]
}
```

---

## 🔄 How It Works (Step by Step)

### 1. **Ride Completion**
```javascript
// When ride completes, fare is set
socket.emit('rideCompleted', {
  rideId: 'ride123',
  fare: 500  // Rider pays ₹500
});
```

### 2. **Fetch Earnings**
```javascript
// Driver opens earnings screen
GET /api/drivers/:id/earnings

// Backend:
// 1. Fetches admin settings
// 2. Gets all completed rides
// 3. Calculates using formulas
// 4. Returns detailed breakdown
```

### 3. **Driver Sees**
```
Ride Fare: ₹500
Platform Fee (20%): -₹100
Your Earning: ₹400
```

---

## 🛠️ Admin Operations

### Set Commission Rates:

```javascript
// POST /api/admin/settings
{
  "pricingConfigurations": {
    "platformFees": 20,
    "driverCommissions": 80
  }
}
```

### Get Current Rates:

```javascript
// GET /api/admin/settings
// Returns current commission configuration
```

---

## 📈 Analytics & Reports

### Total Platform Revenue:
```javascript
// All drivers' platform fees
const allDrivers = await Driver.find();
let totalPlatformRevenue = 0;

for (const driver of allDrivers) {
  const earnings = await getDriverEarnings(driver._id);
  totalPlatformRevenue += earnings.totalPlatformFees;
}
```

### Top Earning Drivers:
```javascript
// Sort drivers by net earnings
const driversWithEarnings = await Promise.all(
  drivers.map(async (driver) => ({
    driver,
    earnings: await getDriverEarnings(driver._id)
  }))
);

driversWithEarnings.sort((a, b) => 
  b.earnings.totalDriverEarnings - a.earnings.totalDriverEarnings
);
```

---

## ⚠️ Important Notes

1. **Only Completed Rides Count**
   - Cancelled rides are NOT included
   - In-progress rides are NOT included
   - Only `status: 'completed'` rides are calculated

2. **Real-time vs Historical**
   - Earnings are calculated when API is called
   - NOT stored in driver model
   - Always reflects current settings

3. **Settings Changes**
   - Changing commission rates affects all future calculations
   - Past calculations remain unchanged (not stored)
   - Historical reports may differ if settings changed

4. **Validation**
   - Ensure `platformFees + driverCommissions = 100`
   - Both should be percentages (0-100)

---

## 🐛 Troubleshooting

### Issue: "Admin settings not found"
**Solution:** Create settings document
```javascript
await Settings.create({
  pricingConfigurations: {
    platformFees: 20,
    driverCommissions: 80,
    baseFare: 40,
    perKmRate: 12,
    minimumFare: 50,
    cancellationFees: 30
  }
});
```

### Issue: Earnings showing as 0
**Possible causes:**
1. No completed rides
2. All rides have fare = 0
3. Driver ID incorrect

**Check:**
```javascript
const rides = await Ride.find({ 
  driver: driverId, 
  status: 'completed' 
});
console.log('Completed rides:', rides.length);
```

---

## 🚀 Future Enhancements

### 1. Time-based Earnings
```javascript
// Add date filters
GET /api/drivers/:id/earnings?startDate=2024-01-01&endDate=2024-01-31
```

### 2. Service-specific Commissions
```javascript
// Different rates for Economy vs Premium
if (ride.rideType === 'premium') {
  commission = 75; // Premium rides: 75%
} else {
  commission = 80; // Economy rides: 80%
}
```

### 3. Incentives & Bonuses
```javascript
// Add bonus earnings
const bonus = calculateDriverBonus(completedRides.length);
totalDriverEarnings += bonus;
```

### 4. Tax Calculations
```javascript
// Add tax deductions
if (settings.gst.enabled) {
  const gst = totalDriverEarnings * (settings.gst.percentage / 100);
  netEarnings = totalDriverEarnings - gst;
}
```

---

## 📞 Support

For questions or issues:
- Email: support@cerca-taxi.com
- Documentation: Check REST_API_DOCUMENTATION.md

---

**Last Updated:** January 2024  
**Version:** 2.0.0  
**Status:** ✅ Production Ready with Admin Settings Integration

