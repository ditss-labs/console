const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware dasar
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== MONGODB CONNECTION ==========
const MONGODB_URI = process.env.MONGODB_URI;
const API_KEY = process.env.APIKEY || 'ampun-dije';

console.log('🚀 Starting server...');
console.log('MONGODB_URI exists:', !!MONGODB_URI);
console.log('API_KEY exists:', !!API_KEY);

if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI not set!');
}

let db = null;
let logsCollection = null;

// Connect to MongoDB
async function connectDB() {
    try {
        console.log('Connecting to MongoDB...');
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        console.log('✅ MongoDB connected');
        
        db = client.db('bot_wa');
        logsCollection = db.collection('console_logs');
        
        // Test insert
        await logsCollection.insertOne({
            type: 'system',
            message: 'Server started',
            createdAt: new Date()
        });
        console.log('✅ Test insert successful');
        
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        return false;
    }
}

// ========== MIDDLEWARE CEK API KEY ==========
function checkApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== API_KEY) {
        console.log('❌ Unauthorized attempt:', apiKey);
        return res.status(401).json({ 
            success: false, 
            error: 'Unauthorized - Invalid API Key' 
        });
    }
    next();
}

// ========== ENDPOINTS ==========

// 1. ROOT ENDPOINT - buat test
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// 2. HEALTH CHECK - buat test koneksi
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        dbConnected: !!logsCollection,
        mongodb_uri_set: !!MONGODB_URI,
        api_key_set: !!API_KEY
    });
});

// 3. TEST ENDPOINT - tanpa auth
app.get('/api/test', (req, res) => {
    res.json({ 
        success: true, 
        message: 'API is working!',
        time: new Date().toISOString()
    });
});

// 4. ENDPOUT CONSOLE - terima log dari bot (PAKAI AUTH)
app.post('/api/console', checkApiKey, async (req, res) => {
    try {
        // Cek database
        if (!logsCollection) {
            return res.status(503).json({ 
                success: false, 
                error: 'Database not ready' 
            });
        }
        
        const logData = req.body;
        console.log('📥 Received log:', logData.type);
        
        // Insert ke database
        const result = await logsCollection.insertOne({
            ...logData,
            _id: `${Date.now()}-${Math.random().toString(36)}`,
            createdAt: new Date(),
            receivedAt: new Date().toISOString()
        });
        
        res.json({ 
            success: true, 
            id: result.insertedId,
            message: 'Log saved'
        });
        
    } catch (error) {
        console.error('Error saving log:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// 5. ENDPOINT GET LOGS
app.get('/api/logs', async (req, res) => {
    try {
        if (!logsCollection) {
            return res.status(503).json({ 
                success: false, 
                error: 'Database not ready' 
            });
        }
        
        const limit = parseInt(req.query.limit) || 100;
        const logs = await logsCollection
            .find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
        
        res.json({
            success: true,
            data: logs.reverse(),
            total: logs.length
        });
        
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// 6. ENDPOINT POLLING SEDERHANA
app.get('/api/poll', async (req, res) => {
    try {
        if (!logsCollection) {
            return res.status(503).json({ 
                success: false, 
                error: 'Database not ready' 
            });
        }
        
        const lastId = req.query.lastId;
        
        let query = {};
        if (lastId) {
            query._id = { $gt: lastId };
        }
        
        const newLogs = await logsCollection
            .find(query)
            .sort({ _id: 1 })
            .limit(10)
            .toArray();
        
        res.json({
            success: true,
            data: newLogs,
            lastId: newLogs.length > 0 ? newLogs[newLogs.length - 1]._id : lastId
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
async function start() {
    // Coba connect ke database
    await connectDB();
    
    app.listen(PORT, () => {
        console.log(`✅ Server running on port ${PORT}`);
        console.log(`📍 Test endpoints:`);
        console.log(`   GET  /api/health`);
        console.log(`   GET  /api/test`);
        console.log(`   POST /api/console (need API Key)`);
        console.log(`   GET  /api/logs`);
        console.log(`   GET  /api/poll`);
    });
}

start();
