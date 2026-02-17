// lib/mongodb.js
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const options = {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
};

let client;
let clientPromise;

if (!process.env.MONGODB_URI) {
    throw new Error('Please add MONGODB_URI to .env');
}

if (process.env.NODE_ENV === 'development') {
    // In development, use a global variable
    if (!global._mongoClientPromise) {
        client = new MongoClient(uri, options);
        global._mongoClientPromise = client.connect();
    }
    clientPromise = global._mongoClientPromise;
} else {
    // In production
    client = new MongoClient(uri, options);
    clientPromise = client.connect();
}

module.exports = clientPromise;
