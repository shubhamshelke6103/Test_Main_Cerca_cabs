const mongoose = require('mongoose');
const Settings = require('../Models/Admin/settings.modal');

/**
 * @desc    Get all settings
 * @route   GET /settings
 */
const getSettings = async (req, res) => {
    try {
        const settings = await Settings.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found' });
        }
        res.status(200).json(settings);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching settings', error });
    }
};

/**
 * @desc    Update settings
 * @route   PUT /settings
 */
const updateSettings = async (req, res) => {
    try {
        // Get existing settings first
        const existingSettings = await Settings.findOne();
        if (!existingSettings) {
            return res.status(404).json({ message: 'Settings not found' });
        }

        // Prepare update object with proper merging for nested objects
        const updateData = { ...req.body };

        // Handle vehicleServices merge - preserve existing fields if not provided
        if (req.body.vehicleServices) {
            const vehicleServices = { ...existingSettings.vehicleServices };
            
            // Merge each vehicle service, preserving required fields
            ['cercaSmall', 'cercaMedium', 'cercaLarge'].forEach(serviceKey => {
                if (req.body.vehicleServices[serviceKey]) {
                    vehicleServices[serviceKey] = {
                        ...existingSettings.vehicleServices[serviceKey],
                        ...req.body.vehicleServices[serviceKey],
                        // Ensure required fields are preserved
                        perMinuteRate: req.body.vehicleServices[serviceKey].perMinuteRate !== undefined
                            ? req.body.vehicleServices[serviceKey].perMinuteRate
                            : existingSettings.vehicleServices[serviceKey]?.perMinuteRate || 
                              (serviceKey === 'cercaSmall' ? 2 : serviceKey === 'cercaMedium' ? 3 : 4),
                        price: req.body.vehicleServices[serviceKey].price !== undefined
                            ? req.body.vehicleServices[serviceKey].price
                            : existingSettings.vehicleServices[serviceKey]?.price || 
                              (serviceKey === 'cercaSmall' ? 299 : serviceKey === 'cercaMedium' ? 499 : 699),
                    };
                }
            });
            
            updateData.vehicleServices = vehicleServices;
        }

        // Handle pricingConfigurations merge
        if (req.body.pricingConfigurations) {
            updateData.pricingConfigurations = {
                ...existingSettings.pricingConfigurations,
                ...req.body.pricingConfigurations
            };
        }

        // Handle other nested objects similarly
        if (req.body.systemSettings) {
            updateData.systemSettings = {
                ...existingSettings.systemSettings,
                ...req.body.systemSettings
            };
        }

        if (req.body.payoutConfigurations) {
            updateData.payoutConfigurations = {
                ...existingSettings.payoutConfigurations,
                ...req.body.payoutConfigurations
            };
        }

        // Validate vehicleServices if provided
        if (updateData.vehicleServices) {
            const vehicleServices = updateData.vehicleServices;
            
            // Validate all required fields exist
            ['cercaSmall', 'cercaMedium', 'cercaLarge'].forEach(serviceKey => {
                if (vehicleServices[serviceKey]) {
                    const service = vehicleServices[serviceKey];
                    if (service.price === undefined || service.price < 0) {
                        return res.status(400).json({ 
                            message: `Invalid price for ${serviceKey}. Price must be a positive number.` 
                        });
                    }
                    if (service.perMinuteRate === undefined || service.perMinuteRate < 0) {
                        return res.status(400).json({ 
                            message: `Invalid perMinuteRate for ${serviceKey}. perMinuteRate must be a positive number.` 
                        });
                    }
                }
            });
        }
        
        const updatedSettings = await Settings.findOneAndUpdate({}, updateData, {
            new: true,
            runValidators: true,
        });
        
        res.status(200).json(updatedSettings);
    } catch (error) {
        res.status(500).json({ 
            message: 'Error updating settings', 
            error: error.message || error 
        });
    }
};

/**
 * @desc    Add new settings (or update if exists)
 * @route   POST /settings
 */
const addSettings = async (req, res) => {
    try {
        // Check if settings already exist
        const existingSettings = await Settings.findOne();
        
        if (existingSettings) {
            // If settings exist, update them instead
            const updatedSettings = await Settings.findOneAndUpdate(
                {},
                req.body,
                { new: true, runValidators: true }
            );
            return res.status(200).json({ 
                message: 'Settings already existed and have been updated', 
                settings: updatedSettings 
            });
        }
        
        // If no settings exist, create new
        const settings = new Settings(req.body);
        await settings.save();
        res.status(201).json({ message: 'Settings added successfully', settings });
    } catch (error) {
        console.error('Error adding settings:', error);
        res.status(500).json({ 
            message: 'Error adding settings', 
            error: error.message,
            details: error 
        });
    }
};

/**
 * @desc    Toggle maintenance mode
 * @route   PATCH /settings/maintenance-mode
 */
const toggleMaintenanceMode = async (req, res) => {
    try {
        const { maintenanceMode } = req.body;
        const settings = await Settings.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found' });
        }
        settings.systemSettings.maintenanceMode = maintenanceMode;
        await settings.save();
        res.status(200).json({ message: 'Maintenance mode updated', maintenanceMode });
    } catch (error) {
        res.status(500).json({ message: 'Error toggling maintenance mode', error });
    }
};

/**
 * @desc    Toggle force update
 * @route   PATCH /settings/force-update
 */
const toggleForceUpdate = async (req, res) => {
    try {
        const { forceUpdate } = req.body;
        const settings = await Settings.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found' });
        }
        settings.systemSettings.forceUpdate = forceUpdate;
        await settings.save();
        res.status(200).json({ message: 'Force update status updated', forceUpdate });
    } catch (error) {
        res.status(500).json({ message: 'Error toggling force update', error });
    }
};

/**
 * @desc    Get vehicle services configuration (Public endpoint for user app)
 * @route   GET /settings/vehicle-services
 */
const getVehicleServices = async (req, res) => {
    try {
        const settings = await Settings.findOne().select('vehicleServices');
        
        if (!settings || !settings.vehicleServices) {
            // Return default values if settings don't exist
            return res.status(200).json({
                cercaSmall: {
                    name: 'Cerca Small',
                    price: 299,
                    seats: 4,
                    enabled: true,
                    imagePath: 'assets/cars/cerca-small.png'
                },
                cercaMedium: {
                    name: 'Cerca Medium',
                    price: 499,
                    seats: 6,
                    enabled: true,
                    imagePath: 'assets/cars/Cerca-medium.png'
                },
                cercaLarge: {
                    name: 'Cerca Large',
                    price: 699,
                    seats: 8,
                    enabled: true,
                    imagePath: 'assets/cars/cerca-large.png'
                }
            });
        }
        
        res.status(200).json(settings.vehicleServices);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching vehicle services', error });
    }
};

/**
 * @desc    Get system settings (maintenance mode, force update, app versions) - Public endpoint for user app
 * @route   GET /admin/settings/system
 */
const getSystemSettings = async (req, res) => {
    try {
        const settings = await Settings.findOne().select('systemSettings appVersions');
        
        if (!settings) {
            // Return default values if settings don't exist
            return res.status(200).json({
                maintenanceMode: false,
                forceUpdate: false,
                maintenanceMessage: null,
                userAppVersion: null
            });
        }
        
        res.status(200).json({
            maintenanceMode: settings.systemSettings?.maintenanceMode || false,
            forceUpdate: settings.systemSettings?.forceUpdate || false,
            maintenanceMessage: settings.systemSettings?.maintenanceMessage || null,
            userAppVersion: settings.appVersions?.userAppVersion || null
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching system settings', error });
    }
};

/**
 * @desc    Get public settings (pricing configurations and vehicle services) - Public endpoint for user app
 * @route   GET /admin/settings/public
 */
const getPublicSettings = async (req, res) => {
    try {
        const settings = await Settings.findOne().select('pricingConfigurations vehicleServices');
        
        if (!settings) {
            // Return default values if settings don't exist
            return res.status(200).json({
                pricingConfigurations: {
                    baseFare: 0,
                    perKmRate: 12,
                    minimumFare: 100,
                    cancellationFees: 50,
                    platformFees: 10,
                    driverCommissions: 90
                },
                vehicleServices: {
                    cercaSmall: {
                        name: 'Cerca Small',
                        price: 299,
                        perMinuteRate: 2,
                        seats: 4,
                        enabled: true,
                        imagePath: 'assets/cars/cerca-small.png'
                    },
                    cercaMedium: {
                        name: 'Cerca Medium',
                        price: 499,
                        perMinuteRate: 3,
                        seats: 6,
                        enabled: true,
                        imagePath: 'assets/cars/Cerca-medium.png'
                    },
                    cercaLarge: {
                        name: 'Cerca Large',
                        price: 699,
                        perMinuteRate: 4,
                        seats: 8,
                        enabled: true,
                        imagePath: 'assets/cars/cerca-large.png'
                    }
                }
            });
        }
        
        // Ensure perMinuteRate is included for each service
        let vehicleServices = settings.vehicleServices || {
            cercaSmall: {
                name: 'Cerca Small',
                price: 299,
                perMinuteRate: 2,
                seats: 4,
                enabled: true,
                imagePath: 'assets/cars/cerca-small.png'
            },
            cercaMedium: {
                name: 'Cerca Medium',
                price: 499,
                perMinuteRate: 3,
                seats: 6,
                enabled: true,
                imagePath: 'assets/cars/Cerca-medium.png'
            },
            cercaLarge: {
                name: 'Cerca Large',
                price: 699,
                perMinuteRate: 4,
                seats: 8,
                enabled: true,
                imagePath: 'assets/cars/cerca-large.png'
            }
        };

        // Ensure perMinuteRate exists for each service
        if (settings.vehicleServices) {
            vehicleServices = { ...settings.vehicleServices };
            ['cercaSmall', 'cercaMedium', 'cercaLarge'].forEach(serviceKey => {
                if (vehicleServices[serviceKey]) {
                    vehicleServices[serviceKey] = {
                        ...vehicleServices[serviceKey],
                        perMinuteRate: vehicleServices[serviceKey].perMinuteRate !== undefined 
                            ? vehicleServices[serviceKey].perMinuteRate
                            : (serviceKey === 'cercaSmall' ? 2 : serviceKey === 'cercaMedium' ? 3 : 4)
                    };
                }
            });
        }

        res.status(200).json({
            pricingConfigurations: settings.pricingConfigurations || {
                baseFare: 0,
                perKmRate: 12,
                minimumFare: 100,
                cancellationFees: 50,
                platformFees: 10,
                driverCommissions: 90
            },
            vehicleServices: vehicleServices
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching public settings', error });
    }
};

module.exports = {
    getSettings,
    updateSettings,
    toggleMaintenanceMode,
    toggleForceUpdate,
    addSettings,
    getVehicleServices,
    getPublicSettings,
    getSystemSettings,
};