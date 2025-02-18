const redis = require('redis');

const createRedisClient = () => {
    const client = redis.createClient({
        url: process.env.REDIS_URL,
        socket: {
            tls: true,
            rejectUnauthorized: true
        }
    });
    client.on('error', (err) => {
        console.error('Redis Client Error:', err);
    });

    return client;
};

module.exports = {
    REDIS_URL,
    createRedisClient
};