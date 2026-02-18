// index.js - Fix untuk error polling

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== MONGODB CONNECTION FIX ==========
const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;

if (!uri) {
    console.error('❌ MONGODB_URI not found in environment variables');
    process.exit(1);
}

const client = new MongoClient(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
});

let db = null;
let logsCollection = null;

// Fungsi untuk connect ke MongoDB
async function connectToMongoDB() {
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB');
        
        db = client.db('bot_wa'); // Ganti 'bot_wa' sesuai database lo
        logsCollection = db.collection('console_logs');
        
        // Create indexes
        await logsCollection.createIndex({ createdAt: -1 });
        await logsCollection.createIndex({ type: 1 });
        
        console.log('✅ Database and collection ready');
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        return false;
    }
}

// ========== MIDDLEWARE CEK DATABASE ==========
// Middleware untuk memastikan database sudah terkoneksi
function ensureDbConnected(req, res, next) {
    if (!logsCollection) {
        return res.status(503).json({ 
            success: false, 
            error: 'Database not ready',
            message: 'MongoDB connection in progress, please try again'
        });
    }
    next();
}

// ========== API ROUTES ==========

// Test endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        dbConnected: !!logsCollection,
        timestamp: new Date().toISOString()
    });
});

// POST /api/console - Terima log dari bot
app.post('/api/console', async (req, res) => {
    // Cek API Key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.APIKEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    // Cek koneksi DB
    if (!logsCollection) {
        return res.status(503).json({ success: false, error: 'Database not ready' });
    }
    
    try {
        const logData = req.body;
        
        // Tambah metadata
        const logEntry = {
            ...logData,
            _id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            createdAt: new Date(),
            receivedAt: new Date().toISOString()
        };
        
        // Simpan ke MongoDB
        await logsCollection.insertOne(logEntry);
        
        res.json({ success: true, id: logEntry._id });
    } catch (error) {
        console.error('Error saving log:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/logs - Ambil logs
app.get('/api/logs', ensureDbConnected, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        
        // Ambil logs
        const logs = await logsCollection
            .find({})
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        
        // Hitung total
        const total = await logsCollection.countDocuments({});
        
        res.json({
            success: true,
            data: logs.reverse(),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/poll - FIXED VERSION (ini yang error tadi)
app.get('/api/poll', async (req, res) => {
    // Set headers untuk long polling
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const lastId = req.query.lastId;
    const timeout = parseInt(req.query.timeout) || 30000;
    
    // CEK PENTING: Kalo db belum siap, return error
    if (!logsCollection) {
        return res.status(503).json({ 
            success: false, 
            error: 'Database not ready',
            data: [] 
        });
    }
    
    try {
        const startTime = Date.now();
        const pollInterval = 2000;
        
        // Build query
        let query = {};
        if (lastId) {
            query._id = { $gt: lastId };
        }
        
        while (Date.now() - startTime < timeout) {
            // CEK ULANG: Pastikan logsCollection masih ada
            if (!logsCollection) {
                throw new Error('Database connection lost');
            }
            
            // Cari logs baru
            const newLogs = await logsCollection
                .find(query)
                .sort({ _id: 1 })
                .limit(50)
                .toArray();
            
            if (newLogs.length > 0) {
                return res.json({
                    success: true,
                    data: newLogs,
                    lastId: newLogs[newLogs.length - 1]._id,
                    timestamp: new Date().toISOString()
                });
            }
            
            // Tunggu bentar sebelum cek lagi
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
        
        // Timeout
        res.json({
            success: true,
            data: [],
            timeout: true,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Polling error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            data: [] 
        });
    }
});

// ========== START SERVER ==========
async function startServer() {
    // Connect ke MongoDB dulu
    const connected = await connectToMongoDB();
    
    if (!connected) {
        console.log('⚠️ Starting server without MongoDB connection...');
        console.log('⚠️ Polling endpoint will return errors until DB connects');
    }
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📡 MongoDB status: ${connected ? 'CONNECTED' : 'DISCONNECTED'}`);
        console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
    });
}

startServer();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    await client.close();
    console.log('👋 MongoDB connection closed');
    process.exit(0);
});

module.exports = app;
