// api/console.js - Endpoint POST dari bot
import clientPromise from '../lib/mongodb';

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Cuma terima POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // Validasi API Key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        const logData = req.body;
        
        // Tambah metadata
        logData._id = new Date().toISOString() + '-' + Math.random().toString(36).substr(2, 9);
        logData.createdAt = new Date();
        logData.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        
        // Simpan ke MongoDB
        const client = await clientPromise;
        const db = client.db('bot_wa');
        const collection = db.collection('console_logs');
        
        await collection.insertOne(logData);
        
        // Hapus logs lama (opsional, simpan 10000 terakhir)
        const count = await collection.countDocuments();
        if (count > 10000) {
            const oldest = await collection.find().sort({ createdAt: 1 }).limit(1).toArray();
            if (oldest.length > 0) {
                await collection.deleteOne({ _id: oldest[0]._id });
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Log saved',
            id: logData._id
        });
        
    } catch (error) {
        console.error('MongoDB error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
