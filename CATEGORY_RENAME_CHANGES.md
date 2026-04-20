# Vehicle Category Renaming Summary

## Overview
The vehicle categories in the Cerca ride-booking system have been renamed from the old names to new branding names. This change affects both user-facing display names and internal system logic.

## Category Mapping

### User-Side Categories (Display Names)
- **Old**: Cerca Small → **New**: Cerca Zip
- **Old**: Cerca Medium → **New**: Cerca Glide  
- **Old**: Cerca Large → **New**: Cerca Titan

### Driver-Side Categories (Vehicle Types)
- **Old**: Hatchback → **New**: Cerca Zip
- **Old**: Sedan → **New**: Cerca Glide
- **Old**: SUV → **New**: Cerca Titan
- **Unchanged**: Auto (remains as legacy support)

## Changes Made

### Backend Changes
1. **Models Updated**:
   - `Models/Driver/ride.model.js`: Enum changed to `['cercaGlide', 'cercaTitan', 'cercaZip', 'auto']`
   - `Models/Driver/driver.model.js`: Enum and default updated
   - `Models/vendor/fleetVehicle.model.js`: Enum and default updated
   - `Models/Admin/settings.modal.js`: Keys, names, and image paths updated

2. **Controllers Updated**:
   - `Controllers/adminSettings.controller.js`: All defaults, mappings, and conditionals
   - `Controllers/User/ride.controller.js`: Service name mappings
   - `Controllers/Driver/driver.controller.js`: Default vehicle types
   - `Controllers/Vendor/fleetVehicle.controller.js`: Default vehicle types

3. **Utils Updated**:
   - `utils/ride_booking_functions.js`: Mapping functions with backward compatibility

4. **Tests Updated**:
   - Test files changed service values to new names

5. **Documentation Updated**:
   - Multiple .md and .json files updated with new examples and defaults

### Frontend Impact
The frontend needs to update the following:

1. **Display Names**: Change UI labels from old names to new names
   - "Cerca Small" → "Cerca Zip"
   - "Cerca Medium" → "Cerca Glide" 
   - "Cerca Large" → "Cerca Titan"

2. **API Requests**: Update service parameters sent to backend
   - Instead of sending `service: 'cercaSmall'`, send `service: 'cercaZip'`
   - Instead of sending `service: 'cercaMedium'`, send `service: 'cercaGlide'`
   - Instead of sending `service: 'cercaLarge'`, send `service: 'cercaTitan'`

3. **API Responses**: Handle new vehicle types in responses
   - Driver vehicle types will now be `'cercaZip'`, `'cercaGlide'`, `'cercaTitan'`, `'auto'`

4. **Image Assets**: Update image paths if using the new naming
   - `assets/cars/cerca-small.png` → `assets/cars/cerca-zip.png`
   - `assets/cars/Cerca-medium.png` → `assets/cars/cerca-glide.png`
   - `assets/cars/cerca-large.png` → `assets/cars/cerca-titan.png`




## Files Changed (Backend)
- Models/Driver/ride.model.js
- Models/Driver/driver.model.js  
- Models/vendor/fleetVehicle.model.js
- Models/Admin/settings.modal.js
- Controllers/adminSettings.controller.js
- Controllers/User/ride.controller.js
- Controllers/Driver/driver.controller.js
- Controllers/Vendor/fleetVehicle.controller.js
- utils/ride_booking_functions.js
- tests/perf/load/*.js
- Multiple documentation files (.md, .json)
