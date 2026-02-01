const mongoose = require('mongoose');
const logger = require('./utils/logger');

const mongoUri = process.env.MONGODB_URI ||
    "mongodb+srv://cercacars:8UJAiLQ4bGkTBIat@cluster0.bvbsosh.mongodb.net/demo_Cerca_API?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connection.on('connected', () => {
    logger.info('🟢 MongoDB connected');
});

mongoose.connection.on('error', (error) => {
    logger.error('🔴 MongoDB connection error:', error);
});

mongoose.connection.on('disconnected', () => {
    logger.warn('⚠️ MongoDB disconnected');
});

const connectDB = async () => {
    try {
        await mongoose.connect(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        logger.info('✅ MongoDB connection established');
    } catch (error) {
        logger.error('❌ MongoDB connection failed:', error);
        throw error;
    }
};

module.exports = { connectDB };
