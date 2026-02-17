// api/poll.js - Endpoint untuk realtime updates
import clientPromise from '../lib/mongodb';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const lastId = req.query.lastId;
    const timeout = parseInt(req.query.timeout) || 30000; // 30 detik default
    
    try {
        const client = await clientPromise;
        const db = client.db('bot_wa');
        const collection = db.collection('console_logs');
        
        // Query untuk cari logs baru
        let query = {};
        if (lastId) {
            query._id = { $gt: lastId };
        }
        
        // Long polling - tunggu sampe ada data baru atau timeout
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            const newLogs = await collection
                .find(query)
                .sort({ _id: 1 })
                .limit(10)
                .toArray();
            
            if (newLogs.length > 0) {
                return res.status(200).json({
                    success: true,
                    data: newLogs.map(log => ({
                        ...log,
                        id: log._id,
                        _id: undefined
                    }))
                });
            }
            
            // Tunggu 1 detik sebelum cek lagi
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Timeout - balikin empty array
        res.status(200).json({
            success: true,
            data: [],
            timeout: true
        });
        
    } catch (error) {
        console.error('Polling error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
