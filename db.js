const mongoose = require('mongoose');
const logger = require('./utils/logger');

// Connection state tracking
let isConnected = false;
let connectionAttempts = 0;
const maxConnectionAttempts = 5;

// MongoDB connection configuration with connection pooling
const mongoOptions = {
    // Connection pooling for 10k users
    minPoolSize: 5, // Minimum number of connections in pool
    maxPoolSize: 50, // Maximum number of connections in pool
    
    // Connection timeout settings
    serverSelectionTimeoutMS: 20000, // How long to try selecting a server
    socketTimeoutMS: 45000, // How long a send or receive on a socket can take before timeout
    connectTimeoutMS: 10000, // How long to wait for initial connection
    
    // Retry settings
    retryWrites: true,
    retryReads: true,
    
    // Write concern
    w: 'majority',
    
    // Additional options
    useUnifiedTopology: true,
    useNewUrlParser: true,
    
    // Heartbeat settings
    heartbeatFrequencyMS: 10000,
    
    // Buffer settings
    bufferMaxEntries: 0, // Disable mongoose buffering
    bufferCommands: false, // Disable mongoose buffering
};

// Connection event handlers
mongoose.connection.on('connected', () => {
    isConnected = true;
    connectionAttempts = 0;
    logger.info('🟢 MongoDB connected successfully');
    logger.info(`📊 Connection pool: ${mongoose.connection.readyState === 1 ? 'Active' : 'Inactive'}`);
});

mongoose.connection.on('error', (error) => {
    isConnected = false;
    logger.error('🔴 MongoDB connection error:', {
        message: error.message,
        name: error.name
    });
});

mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('⚠️ MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
    isConnected = true;
    logger.info('🔄 MongoDB reconnected');
});

mongoose.connection.on('connecting', () => {
    logger.info('🔄 MongoDB connecting...');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('🛑 SIGTERM received, closing MongoDB connection...');
    await mongoose.connection.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('🛑 SIGINT received, closing MongoDB connection...');
    await mongoose.connection.close();
    process.exit(0);
});

// Connection function with retry logic
const connectDB = async (retryCount = 0) => {
    const mongoUri = process.env.MONGODB_URI || 
        "mongodb+srv://shubhamshelke6103_db:shubham011@cluster0.23riiuz.mongodb.net/demo_Cerca_API?retryWrites=true&w=majority&appName=Cluster0";
    
    try {
        connectionAttempts = retryCount + 1;
        
        if (retryCount > 0) {
            const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff, max 10s
            logger.info(`🔄 Retrying MongoDB connection (attempt ${retryCount + 1}/${maxConnectionAttempts}) in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        await mongoose.connect(mongoUri, mongoOptions);
        
        // Log connection pool info
        const poolSize = mongoose.connection.db?.serverConfig?.poolSize || 'unknown';
        logger.info(`✅ MongoDB connection pool configured: min=${mongoOptions.minPoolSize}, max=${mongoOptions.maxPoolSize}`);
        
        return true;
    } catch (error) {
        logger.error(`❌ MongoDB connection error (attempt ${retryCount + 1}/${maxConnectionAttempts}):`, {
            message: error.message,
            name: error.name,
            code: error.code
        });
        
        if (retryCount < maxConnectionAttempts - 1) {
            // Retry with exponential backoff
            return connectDB(retryCount + 1);
        } else {
            logger.error('❌ Max MongoDB connection attempts reached, exiting...');
            process.exit(1);
        }
    }
};

// Health check function
async function checkMongoDBHealth() {
    try {
        if (!isConnected || mongoose.connection.readyState !== 1) {
            return {
                healthy: false,
                error: 'Not connected',
                readyState: mongoose.connection.readyState,
                connectionAttempts
            };
        }
        
        // Ping the database
        const start = Date.now();
        await mongoose.connection.db.admin().ping();
        const latency = Date.now() - start;
        
        return {
            healthy: true,
            latency: `${latency}ms`,
            readyState: mongoose.connection.readyState,
            host: mongoose.connection.host,
            port: mongoose.connection.port,
            name: mongoose.connection.name
        };
    } catch (error) {
        return {
            healthy: false,
            error: error.message,
            readyState: mongoose.connection.readyState,
            connectionAttempts
        };
    }
}

module.exports = {
    connectDB,
    checkMongoDBHealth,
    getMongoDBStatus: () => ({
        isConnected,
        readyState: mongoose.connection.readyState,
        connectionAttempts,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        name: mongoose.connection.name
    })
};