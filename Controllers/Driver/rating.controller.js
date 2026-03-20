const Rating = require('../../Models/Driver/rating.model.js');
const Driver = require('../../Models/Driver/driver.model.js');
const User = require('../../Models/User/user.model.js');
const Ride = require('../../Models/Driver/ride.model.js');
const logger = require('../../utils/logger.js');

const maskName = (value) => {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (trimmed.length <= 2) return `${trimmed[0] || ''}*`;
    return `${trimmed[0]}${'*'.repeat(Math.max(1, trimmed.length - 2))}${trimmed[trimmed.length - 1]}`;
};

const maskPhone = (value) => {
    if (!value) return null;
    const stringValue = String(value);
    if (stringValue.length <= 4) return stringValue;
    return `${'*'.repeat(Math.max(0, stringValue.length - 4))}${stringValue.slice(-4)}`;
};

const serializeRating = (ratingDoc) => ({
    id: ratingDoc._id,
    ride: ratingDoc.ride,
    ratedByModel: ratingDoc.ratedByModel,
    ratedToModel: ratingDoc.ratedToModel,
    rating: ratingDoc.rating,
    review: ratingDoc.review,
    tags: ratingDoc.tags || [],
    createdAt: ratingDoc.createdAt,
    ratedBy: {
        name: maskName(ratingDoc.ratedBySnapshot?.name),
        phone: maskPhone(ratingDoc.ratedBySnapshot?.phone),
    },
    ratedTo: {
        name: maskName(ratingDoc.ratedToSnapshot?.name),
        phone: maskPhone(ratingDoc.ratedToSnapshot?.phone),
    },
});

/**
 * @desc    Submit a rating for a ride
 * @route   POST /ratings
 */
const submitRating = async (req, res) => {
    try {
        const { rideId, ratedBy, ratedByModel, ratedTo, ratedToModel, rating, review, tags } = req.body;

        // Validate required fields
        if (!rideId || !ratedBy || !ratedByModel || !ratedTo || !ratedToModel || !rating) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        // Validate rating value
        if (rating < 1 || rating > 5) {
            return res.status(400).json({ message: 'Rating must be between 1 and 5' });
        }

        // Check if ride exists
        const ride = await Ride.findById(rideId);
        if (!ride) {
            return res.status(404).json({ message: 'Ride not found' });
        }

        const RatedByModel = ratedByModel === 'Driver' ? Driver : User;
        const RatedToModel = ratedToModel === 'Driver' ? Driver : User;
        const [ratedByEntity, ratedToEntity] = await Promise.all([
            RatedByModel.findById(ratedBy).select('name fullName phone phoneNumber email'),
            RatedToModel.findById(ratedTo).select('name fullName phone phoneNumber email'),
        ]);

        // Check if ride is completed
        if (ride.status !== 'completed') {
            return res.status(400).json({ 
                message: 'Rating can only be submitted for completed rides' 
            });
        }

        // Check if rating already exists
        const existingRating = await Rating.findOne({ 
            ride: rideId, 
            ratedBy, 
            ratedByModel 
        });

        if (existingRating) {
            return res.status(400).json({ message: 'Rating already submitted for this ride' });
        }

        // Create rating
        const newRating = await Rating.create({
            ride: rideId,
            ratedBy,
            ratedByModel,
            ratedTo,
            ratedToModel,
            rating,
            review,
            tags,
            ratedBySnapshot: ratedByEntity ? {
                name: ratedByEntity.name || ratedByEntity.fullName || null,
                phone: ratedByEntity.phone || ratedByEntity.phoneNumber || null,
                email: ratedByEntity.email || null,
            } : {},
            ratedToSnapshot: ratedToEntity ? {
                name: ratedToEntity.name || ratedToEntity.fullName || null,
                phone: ratedToEntity.phone || ratedToEntity.phoneNumber || null,
                email: ratedToEntity.email || null,
            } : {},
        });

        // Update ride with rating
        if (ratedByModel === 'User') {
            await Ride.findByIdAndUpdate(rideId, { driverRating: rating });
        } else {
            await Ride.findByIdAndUpdate(rideId, { riderRating: rating });
        }

        // Calculate and update average rating
        await updateAverageRating(ratedTo, ratedToModel);

        logger.info(`Rating submitted: ${newRating._id}`);
        res.status(201).json({ 
            message: 'Rating submitted successfully', 
            rating: serializeRating(newRating) 
        });
    } catch (error) {
        logger.error('Error submitting rating:', error);
        res.status(500).json({ message: 'Error submitting rating', error: error.message });
    }
};

/**
 * @desc    Get ratings for a specific entity (Driver or User)
 * @route   GET /ratings/:entityModel/:entityId
 */
const getRatingsForEntity = async (req, res) => {
    try {
        const { entityModel, entityId } = req.params;
        const { limit = 20, skip = 0 } = req.query;

        if (!['Driver', 'User'].includes(entityModel)) {
            return res.status(400).json({ message: 'Invalid entity model' });
        }

        const ratings = await Rating.find({ 
            ratedTo: entityId, 
            ratedToModel: entityModel 
        })
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(parseInt(skip));

        const totalRatings = await Rating.countDocuments({ 
            ratedTo: entityId, 
            ratedToModel: entityModel 
        });

        res.status(200).json({ 
            ratings: ratings.map(serializeRating), 
            total: totalRatings,
            count: ratings.length 
        });
    } catch (error) {
        logger.error('Error fetching ratings:', error);
        res.status(500).json({ message: 'Error fetching ratings', error: error.message });
    }
};

/**
 * @desc    Get rating for a specific ride
 * @route   GET /ratings/ride/:rideId
 */
const getRatingByRide = async (req, res) => {
    try {
        const { rideId } = req.params;

        const ratings = await Rating.find({ ride: rideId })
            .sort({ createdAt: -1 });

        res.status(200).json({ ratings: ratings.map(serializeRating) });
    } catch (error) {
        logger.error('Error fetching ride ratings:', error);
        res.status(500).json({ message: 'Error fetching ride ratings', error: error.message });
    }
};

/**
 * @desc    Get average rating and stats for an entity
 * @route   GET /ratings/:entityModel/:entityId/stats
 */
const getRatingStats = async (req, res) => {
    try {
        const { entityModel, entityId } = req.params;

        if (!['Driver', 'User'].includes(entityModel)) {
            return res.status(400).json({ message: 'Invalid entity model' });
        }

        const ratings = await Rating.find({ 
            ratedTo: entityId, 
            ratedToModel: entityModel 
        });

        if (ratings.length === 0) {
            return res.status(200).json({
                averageRating: 0,
                totalRatings: 0,
                ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
            });
        }

        const totalRating = ratings.reduce((sum, r) => sum + r.rating, 0);
        const averageRating = (totalRating / ratings.length).toFixed(2);

        // Rating distribution
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratings.forEach(r => {
            distribution[r.rating]++;
        });

        res.status(200).json({
            averageRating: parseFloat(averageRating),
            totalRatings: ratings.length,
            ratingDistribution: distribution
        });
    } catch (error) {
        logger.error('Error fetching rating stats:', error);
        res.status(500).json({ message: 'Error fetching rating stats', error: error.message });
    }
};

/**
 * @desc    Delete a rating (admin only)
 * @route   DELETE /ratings/:id
 */
const deleteRating = async (req, res) => {
    try {
        const { id } = req.params;

        const rating = await Rating.findByIdAndDelete(id);

        if (!rating) {
            return res.status(404).json({ message: 'Rating not found' });
        }

        // Recalculate average rating
        await updateAverageRating(rating.ratedTo, rating.ratedToModel);

        logger.info(`Rating deleted: ${id}`);
        res.status(200).json({ message: 'Rating deleted successfully' });
    } catch (error) {
        logger.error('Error deleting rating:', error);
        res.status(500).json({ message: 'Error deleting rating', error: error.message });
    }
};

/**
 * Helper function to update average rating
 */
const updateAverageRating = async (entityId, entityModel) => {
    try {
        const ratings = await Rating.find({ 
            ratedTo: entityId, 
            ratedToModel: entityModel 
        });

        const Model = entityModel === 'Driver' ? Driver : User;
        
        if (ratings.length === 0) {
            await Model.findByIdAndUpdate(entityId, {
                rating: 0,
                totalRatings: 0,
            });
            return;
        }

        const totalRating = ratings.reduce((sum, r) => sum + r.rating, 0);
        const averageRating = (totalRating / ratings.length).toFixed(2);

        await Model.findByIdAndUpdate(entityId, {
            rating: parseFloat(averageRating),
            totalRatings: ratings.length,
        });
    } catch (error) {
        logger.error('Error updating average rating:', error);
    }
};

module.exports = {
    submitRating,
    getRatingsForEntity,
    getRatingByRide,
    getRatingStats,
    deleteRating,
};

