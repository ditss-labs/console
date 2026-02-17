// api/logs.js - Endpoint GET untuk frontend
import clientPromise from '../lib/mongodb';

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const limit = parseInt(req.query.limit) || 100;
        const before = req.query.before; // Untuk pagination
        const type = req.query.type; // Filter by type
        const botName = req.query.bot; // Filter by bot name
        
        const client = await clientPromise;
        const db = client.db('bot_wa');
        const collection = db.collection('console_logs');
        
        // Build query
        let query = {};
        if (before) {
            query.createdAt = { $lt: new Date(before) };
        }
        if (type) {
            query.type = type;
        }
        if (botName) {
            query.botName = botName;
        }
        
        const logs = await collection
            .find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
        
        // Format response
        const formattedLogs = logs.map(log => ({
            ...log,
            id: log._id,
            _id: undefined // Hapus _id biar ga bingung
        }));
        
        res.status(200).json({
            success: true,
            data: formattedLogs.reverse(), // Balikin urut dari lama ke baru
            total: await collection.countDocuments(query),
            hasMore: logs.length === limit
        });
        
    } catch (error) {
        console.error('MongoDB error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
