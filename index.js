// index.js - Main Express Application
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
require('dotenv').config();

// Import MongoDB connection
const clientPromise = require('./lib/mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ==================== DATABASE CONNECTION ====================
let db;
let logsCollection;

async function connectToMongoDB() {
    try {
        const client = await clientPromise;
        db = client.db('bot_wa');
        logsCollection = db.collection('console_logs');
        console.log('✅ Connected to MongoDB');
        
        // Create indexes for better performance
        await logsCollection.createIndex({ createdAt: -1 });
        await logsCollection.createIndex({ type: 1 });
        await logsCollection.createIndex({ botName: 1 });
        await logsCollection.createIndex({ 'userInfo.nomor': 1 });
        
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// ==================== API MIDDLEWARE ====================
// API Key validation
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized - Invalid API Key'
        });
    }
    next();
};

// ==================== API ROUTES ====================

/**
 * POST /api/console
 * Receive logs from WhatsApp bot
 */
app.post('/api/console', validateApiKey, async (req, res) => {
    try {
        const logData = req.body;
        
        // Validate required fields
        if (!logData || !logData.type) {
            return res.status(400).json({
                success: false,
                error: 'Invalid log data - type is required'
            });
        }

        // Prepare log entry
        const logEntry = {
            ...logData,
            _id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            createdAt: new Date(),
            receivedAt: new Date().toISOString(),
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
        };

        // Insert to MongoDB
        await logsCollection.insertOne(logEntry);

        // Clean up old logs (keep last 10,000)
        try {
            const count = await logsCollection.countDocuments();
            if (count > 10000) {
                const oldestLogs = await logsCollection
                    .find({})
                    .sort({ createdAt: 1 })
                    .limit(count - 10000)
                    .toArray();
                
                if (oldestLogs.length > 0) {
                    await logsCollection.deleteMany({
                        _id: { $in: oldestLogs.map(log => log._id) }
                    });
                }
            }
        } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError);
        }

        // Success response
        res.status(200).json({
            success: true,
            message: 'Log saved successfully',
            id: logEntry._id,
            timestamp: logEntry.createdAt
        });

    } catch (error) {
        console.error('Error saving log:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * GET /api/logs
 * Get logs with pagination and filters
 */
app.get('/api/logs', async (req, res) => {
    try {
        // Parse query parameters
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        
        const type = req.query.type;
        const botName = req.query.bot;
        const nomor = req.query.nomor;
        const startDate = req.query.start ? new Date(req.query.start) : null;
        const endDate = req.query.end ? new Date(req.query.end) : null;
        const search = req.query.search;

        // Build query
        let query = {};
        
        if (type && type !== 'all') {
            query.type = type;
        }
        
        if (botName) {
            query.botName = botName;
        }
        
        if (nomor) {
            query['userInfo.nomor'] = { $regex: nomor, $options: 'i' };
        }
        
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = startDate;
            if (endDate) query.createdAt.$lte = endDate;
        }
        
        if (search) {
            query.$or = [
                { 'messageInfo.body': { $regex: search, $options: 'i' } },
                { 'messageInfo.command': { $regex: search, $options: 'i' } },
                { 'userInfo.pushname': { $regex: search, $options: 'i' } },
                { 'userInfo.nomor': { $regex: search, $options: 'i' } }
            ];
        }

        // Get total count for pagination
        const total = await logsCollection.countDocuments(query);

        // Get logs
        const logs = await logsCollection
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Get unique bot names for filter
        const botNames = await logsCollection.distinct('botName');
        
        // Get unique types for filter
        const types = await logsCollection.distinct('type');

        res.status(200).json({
            success: true,
            data: logs.reverse(), // Return oldest first for display
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
                hasMore: skip + logs.length < total
            },
            filters: {
                botNames: botNames.filter(Boolean),
                types: types.filter(Boolean)
            }
        });

    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * GET /api/poll
 * Long polling for realtime updates
 */
app.get('/api/poll', async (req, res) => {
    // Set headers for long polling
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const lastId = req.query.lastId;
    const timeout = Math.min(parseInt(req.query.timeout) || 30000, 60000);
    const type = req.query.type;

    try {
        // Build query for new logs
        let query = {};
        if (lastId) {
            query._id = { $gt: lastId };
        }
        if (type && type !== 'all') {
            query.type = type;
        }

        // Long polling - wait for new data or timeout
        const startTime = Date.now();
        const pollInterval = 2000;

        while (Date.now() - startTime < timeout) {
            // Check for new logs
            const newLogs = await logsCollection
                .find(query)
                .sort({ _id: 1 })
                .limit(50)
                .toArray();

            if (newLogs.length > 0) {
                return res.status(200).json({
                    success: true,
                    data: newLogs,
                    lastId: newLogs[newLogs.length - 1]._id,
                    timestamp: new Date().toISOString()
                });
            }

            // Wait before next check
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // Timeout - return empty response
        res.status(200).json({
            success: true,
            data: [],
            timeout: true,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Polling error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * DELETE /api/logs
 * Clear all logs (protected with API key)
 */
app.delete('/api/logs', validateApiKey, async (req, res) => {
    try {
        await logsCollection.deleteMany({});
        res.status(200).json({
            success: true,
            message: 'All logs cleared successfully'
        });
    } catch (error) {
        console.error('Error clearing logs:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * GET /api/stats
 * Get statistics about logs
 */
app.get('/api/stats', async (req, res) => {
    try {
        const total = await logsCollection.countDocuments();
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const todayCount = await logsCollection.countDocuments({
            createdAt: { $gte: today }
        });
        
        const typeStats = await logsCollection.aggregate([
            { $group: { _id: '$type', count: { $sum: 1 } } }
        ]).toArray();
        
        const botStats = await logsCollection.aggregate([
            { $group: { _id: '$botName', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]).toArray();

        res.status(200).json({
            success: true,
            data: {
                total,
                today: todayCount,
                byType: typeStats,
                topBots: botStats
            }
        });

    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

// ==================== FRONTEND ROUTES ====================
// Catch-all route to serve index.html for client-side routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ERROR HANDLING ====================
// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// ==================== START SERVER ====================
async function startServer() {
    await connectToMongoDB();
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📡 API endpoints:`);
        console.log(`   POST  http://localhost:${PORT}/api/console`);
        console.log(`   GET   http://localhost:${PORT}/api/logs`);
        console.log(`   GET   http://localhost:${PORT}/api/poll`);
        console.log(`   GET   http://localhost:${PORT}/api/stats`);
        console.log(`   DELETE http://localhost:${PORT}/api/logs`);
    });
}

// For Vercel serverless
if (require.main === module) {
    startServer();
}

// Export for Vercel
module.exports = app;
