/**
 * Backfill script to create AdminEarnings records for existing completed rides
 * 
 * Usage: 
 *   node utils/backfillEarnings.js                    # Dry run (preview only)
 *   node utils/backfillEarnings.js --execute          # Execute backfill
 *   node utils/backfillEarnings.js --fix              # Fix incorrect earnings
 *   node utils/backfillEarnings.js --batch=100        # Process in batches
 *   node utils/backfillEarnings.js --start-from=ID    # Resume from specific ride ID
 * 
 * This script:
 * 1. Finds all completed rides that don't have AdminEarnings records
 * 2. Creates AdminEarnings records for them using current settings
 * 3. Logs progress and results
 * 4. Supports dry-run mode, batch processing, and incremental backfill
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../db');
const logger = require('./logger');

const Ride = require('../Models/Driver/ride.model');
const AdminEarnings = require('../Models/Admin/adminEarnings.model');
const Settings = require('../Models/Admin/settings.modal');

async function backfillEarnings(options = {}) {
  const {
    dryRun = !process.argv.includes('--execute'),
    fixMode = process.argv.includes('--fix'),
    batchSize = parseInt(process.argv.find(arg => arg.startsWith('--batch='))?.split('=')[1] || '100'),
    startFromRideId = process.argv.find(arg => arg.startsWith('--start-from='))?.split('=')[1] || null
  } = options;

  try {
    // Connect to database
    await connectDB();
    logger.info('✅ Connected to database');
    
    if (dryRun) {
      logger.info('🔍 DRY RUN MODE - No changes will be made');
    } else {
      logger.info('🔧 EXECUTE MODE - Changes will be saved');
    }
    
    if (fixMode) {
      logger.info('🔧 FIX MODE - Will correct incorrect earnings calculations');
    }

    // Get settings for commission calculation
    const settings = await Settings.findOne();
    if (!settings) {
      logger.error('❌ Settings not found. Please create settings first.');
      process.exit(1);
    }

    if (!settings.pricingConfigurations) {
      logger.error('❌ pricingConfigurations missing in settings. Please configure pricing.');
      process.exit(1);
    }

    const { platformFees, driverCommissions } = settings.pricingConfigurations;
    logger.info(`📊 Using settings - platformFees: ${platformFees}%, driverCommissions: ${driverCommissions}%`);

    // Find all completed rides
    const completedRides = await Ride.find({ status: 'completed' })
      .populate('driver', '_id')
      .populate('rider', '_id')
      .sort({ createdAt: -1 });

    logger.info(`📦 Found ${completedRides.length} completed rides`);

    if (completedRides.length === 0) {
      logger.info('✅ No completed rides found. Nothing to backfill.');
      process.exit(0);
    }

    // Get existing AdminEarnings rideIds to avoid duplicates
    const existingEarnings = await AdminEarnings.find({}).select('rideId');
    const existingRideIds = new Set(existingEarnings.map(e => e.rideId.toString()));
    logger.info(`📋 Found ${existingRideIds.size} existing earnings records`);

    // Filter rides that don't have earnings records (or need fixing in fix mode)
    let ridesToProcess = [];
    
    if (fixMode) {
      // In fix mode, find rides with incorrect earnings
      const { findIncorrectEarnings } = require('./earningsValidator');
      const incorrectResult = await findIncorrectEarnings();
      logger.info(`🔧 Found ${incorrectResult.incorrectCount || 0} rides with incorrect earnings`);
      
      // Get ride IDs that need fixing
      const incorrectRideIds = new Set(
        (incorrectResult.incorrectEarnings || []).map(e => e.rideId)
      );
      
      ridesToProcess = completedRides.filter(ride => {
        const rideId = ride._id.toString();
        return incorrectRideIds.has(rideId);
      });
    } else {
      // Normal mode: find rides without earnings
      ridesToProcess = completedRides.filter(ride => {
        const rideId = ride._id.toString();
        return !existingRideIds.has(rideId);
      });
    }

    // Filter by startFromRideId if provided (for incremental backfill)
    if (startFromRideId) {
      const startIndex = ridesToProcess.findIndex(ride => ride._id.toString() === startFromRideId);
      if (startIndex >= 0) {
        ridesToProcess = ridesToProcess.slice(startIndex);
        logger.info(`📍 Resuming from ride ID: ${startFromRideId}`);
      } else {
        logger.warn(`⚠️ Start ride ID ${startFromRideId} not found, processing all rides`);
      }
    }

    logger.info(`🔄 Processing ${ridesToProcess.length} rides${fixMode ? ' with incorrect earnings' : ' without earnings records'}`);

    if (ridesToProcess.length === 0) {
      logger.info(`✅ ${fixMode ? 'No rides with incorrect earnings found' : 'All completed rides already have earnings records'}. Nothing to ${fixMode ? 'fix' : 'backfill'}.`);
      process.exit(0);
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    let processedCount = 0;

    // Process in batches
    const batches = [];
    for (let i = 0; i < ridesToProcess.length; i += batchSize) {
      batches.push(ridesToProcess.slice(i, i + batchSize));
    }

    logger.info(`📦 Processing in ${batches.length} batches of ${batchSize} rides each`);

    // Process each batch
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      logger.info(`\n📦 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} rides)`);

      // Process each ride in batch
      for (const ride of batch) {
        try {
        // Validate ride data
        if (!ride._id) {
          logger.warn(`⚠️ Skipping ride with missing ID`);
          errorCount++;
          continue;
        }

        const rideId = ride._id.toString();
        const driverId = ride.driver?._id || ride.driver;
        const riderId = ride.rider?._id || ride.rider;

        if (!driverId) {
          logger.warn(`⚠️ Skipping ride ${rideId} - missing driver`);
          errorCount++;
          errors.push({ rideId, error: 'Missing driver' });
          continue;
        }

        if (!riderId) {
          logger.warn(`⚠️ Skipping ride ${rideId} - missing rider`);
          errorCount++;
          errors.push({ rideId, error: 'Missing rider' });
          continue;
        }

        const grossFare = ride.fare || 0;

        if (grossFare <= 0) {
          logger.warn(`⚠️ Skipping ride ${rideId} - invalid fare: ₹${grossFare}`);
          errorCount++;
          errors.push({ rideId, error: `Invalid fare: ₹${grossFare}` });
          continue;
        }

        // Calculate platform fee and driver earning
        const platformFee = platformFees ? grossFare * (platformFees / 100) : 0;
        const driverEarning = driverCommissions
          ? grossFare * (driverCommissions / 100)
          : grossFare - platformFee;

        // Calculate rounded values
        let roundedPlatformFee = Math.round(platformFee * 100) / 100;
        let roundedDriverEarning = Math.round(driverEarning * 100) / 100;

        // Verify calculation accuracy
        const tolerance = 0.01;
        const calculatedTotal = roundedPlatformFee + roundedDriverEarning;
        if (Math.abs(grossFare - calculatedTotal) > tolerance) {
          logger.warn(`⚠️ Calculation mismatch for ride ${rideId} - adjusting driverEarning`);
          roundedDriverEarning = Math.round((grossFare - roundedPlatformFee) * 100) / 100;
        }

        if (dryRun) {
          // Dry run: just log what would be created/updated
          logger.info(`[DRY RUN] Would ${fixMode ? 'update' : 'create'} earnings for ride ${rideId}:`);
          logger.info(`  grossFare: ₹${grossFare}, platformFee: ₹${roundedPlatformFee}, driverEarning: ₹${roundedDriverEarning}`);
          successCount++;
        } else {
          // Execute: create or update earnings record
          if (fixMode) {
            // Update existing earnings record
            await AdminEarnings.findOneAndUpdate(
              { rideId: rideId },
              {
                grossFare: grossFare,
                platformFee: roundedPlatformFee,
                driverEarning: roundedDriverEarning,
                rideDate: ride.actualEndTime || ride.updatedAt || ride.createdAt || new Date()
              },
              { new: true }
            );
          } else {
            // Create new earnings record
            await AdminEarnings.create({
              rideId: rideId,
              driverId: driverId.toString(),
              riderId: riderId.toString(),
              grossFare: grossFare,
              platformFee: roundedPlatformFee,
              driverEarning: roundedDriverEarning,
              rideDate: ride.actualEndTime || ride.updatedAt || ride.createdAt || new Date(),
              paymentStatus: 'pending'
            });
          }
          successCount++;
        }
        
          processedCount++;
          if (processedCount % 10 === 0) {
            logger.info(`📊 Progress: ${processedCount}/${ridesToProcess.length} processed`);
          }
        } catch (error) {
          errorCount++;
          const rideId = ride._id?.toString() || 'unknown';
          logger.error(`❌ Error processing ride ${rideId}:`, error.message);
          errors.push({ rideId, error: error.message });
        }
      } // End of ride loop
    } // End of batch loop

    // Summary
    logger.info('\n' + '='.repeat(60));
    logger.info(`📊 ${fixMode ? 'FIX' : 'BACKFILL'} SUMMARY ${dryRun ? '(DRY RUN)' : ''}`);
    logger.info('='.repeat(60));
    logger.info(`✅ Successfully ${dryRun ? 'would process' : 'processed'}: ${successCount} rides`);
    logger.info(`❌ Errors: ${errorCount} rides`);
    logger.info(`📦 Total rides ${dryRun ? 'would be' : ''} processed: ${ridesToProcess.length}`);
    
    if (dryRun && successCount > 0) {
      logger.info('\n💡 To execute this backfill, run with --execute flag');
    }
    
    if (errors.length > 0) {
      logger.info('\n❌ Errors encountered:');
      errors.slice(0, 10).forEach(({ rideId, error }) => {
        logger.info(`   - Ride ${rideId}: ${error}`);
      });
      if (errors.length > 10) {
        logger.info(`   ... and ${errors.length - 10} more errors`);
      }
    }

    logger.info('='.repeat(60));
    logger.info(`✅ ${fixMode ? 'Fix' : 'Backfill'} ${dryRun ? 'preview' : ''} completed!`);
    
    // Validation after backfill
    if (!dryRun && successCount > 0) {
      logger.info('\n🔍 Validating results...');
      const { findMissingEarnings } = require('./earningsValidator');
      const missingResult = await findMissingEarnings();
      if (missingResult.missingCount === 0) {
        logger.info('✅ Validation passed - all completed rides have earnings records');
      } else {
        logger.warn(`⚠️ Validation warning - ${missingResult.missingCount} rides still missing earnings`);
      }
    }

    process.exit(0);
  } catch (error) {
    logger.error('❌ Fatal error in backfill script:', error);
    process.exit(1);
  }
}

// Run the backfill
if (require.main === module) {
  backfillEarnings()
    .then(() => {
      logger.info('✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { backfillEarnings };

