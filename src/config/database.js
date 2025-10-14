// config/database.js
const mongoose = require('mongoose');

const connectDatabase = async () => {
    try {
        // Connect to MongoDB using environment variable
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("✅ Successfully connected to MongoDB Atlas");
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB Atlas:", error);
        process.exit(1);
    }
};

// Handle connection events
mongoose.connection.on('connected', () => {
    console.log('📦 Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (error) => {
    console.error('❌ Mongoose connection error:', error);
});

mongoose.connection.on('disconnected', () => {
    console.log('📤 Mongoose disconnected from MongoDB');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    try {
        await mongoose.connection.close();
        console.log('📤 MongoDB connection closed through app termination');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during MongoDB disconnect:', error);
        process.exit(1);
    }
});

module.exports = { connectDatabase };