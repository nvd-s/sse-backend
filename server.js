const express = require('express');
const Redis = require('ioredis');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require("dotenv");

dotenv.config();

const redisURL = process.env.REDIS_URL;

const app = express();
const PORT = 3000;
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(bodyParser.json());

// Redis setup with connection options
const subscriber = new Redis(
    process.env.REDIS_URL,
    {
        tls: { rejectUnauthorized: false },
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            console.log(`[Redis] Connection attempt ${times}, retrying in ${delay}ms`);
            return delay;
        },
        maxRetriesPerRequest: 3
    }
);

const subscribedChannels = new Set();
const clients = new Map(); // Stores client ID and response object
const clientSubscriptions = new Map(); // Tracks which vehicles each client is subscribed to (array of channels)

// Redis connection event handlers
subscriber.on('connect', () => {
    console.log('[Redis] Connected successfully');
    // Resubscribe to all channels if we reconnect
    if (subscribedChannels.size > 0) {
        console.log(`[Redis] Resubscribing to ${subscribedChannels.size} channels`);
        subscribedChannels.forEach(channel => {
            subscriber.subscribe(channel);
        });
    }
});

subscriber.on('error', (err) => {
    console.error('[Redis] Error:', err);
    notifyClientsOfRedisError();
});

subscriber.on('close', () => {
    console.log('[Redis] Connection closed');
    notifyClientsOfRedisError();
});

subscriber.on('reconnecting', (delay) => {
    console.log(`[Redis] Reconnecting in ${delay}ms...`);
});

subscriber.on('end', () => {
    console.log('[Redis] Connection ended');
    notifyClientsOfRedisError();
});

// Function to notify all connected clients of Redis errors
function notifyClientsOfRedisError() {
    const errorMessage = {
        type: 'error',
        message: 'Redis connection lost. Updates may be unavailable.',
        timestamp: new Date().toISOString()
    };

    clients.forEach((client) => {
        try {
            client.write(`data: ${JSON.stringify(errorMessage)}\n\n`);
        } catch (err) {
            console.error('[SSE] Error sending Redis error to client:', err);
        }
    });
}

// Handle messages and send only to subscribed clients
subscriber.on('message', (channel, message) => {
    console.log(`[Redis] Message received on ${channel}:`);

    try {
        const data = JSON.parse(message);
        const vehicleId = data.vehicleName;

        // Notify all clients subscribed to this vehicle's channel
        clients.forEach((client, clientId) => {
            const clientChannels = clientSubscriptions.get(clientId) || [];
            if (clientChannels.includes(channel)) {
                try {
                    client.write(`data: ${JSON.stringify(data)}\n\n`);
                } catch (err) {
                    console.error(`[SSE] Error sending message to client ${clientId}:`, err);
                    cleanupClient(clientId);
                }
            }
        });
    } catch (error) {
        console.error('[Redis] Message parsing error:', error);
    }
});

// Function to handle client cleanup
function cleanupClient(clientId) {
    const channels = clientSubscriptions.get(clientId) || [];
    clients.delete(clientId);
    clientSubscriptions.delete(clientId);

    // For each channel this client was subscribed to
    channels.forEach(channel => {
        // Check if anyone else is still subscribed to this channel
        let stillInUse = false;
        clientSubscriptions.forEach(subscribedChannels => {
            if (subscribedChannels.includes(channel)) {
                stillInUse = true;
            }
        });

        // Unsubscribe if no more clients need this channel
        if (!stillInUse) {
            console.log(`[Redis] No more clients for ${channel}, unsubscribing`);
            subscriber.unsubscribe(channel);
            subscribedChannels.delete(channel);
        }
    });
}

// SSE endpoint: Subscribe to multiple vehicles in a single connection
app.get('/events', (req, res) => {
    console.log('[SSE] Client connected');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Check Redis connection status first
    if (subscriber.status !== 'ready') {
        res.write('data: {"status": "connected", "warning": "Redis connection is unavailable. Reconnecting..."}\n\n');
    } else {
        res.write('data: {"status": "connected"}\n\n');
    }

    const clientId = req.ip || req.connection.remoteAddress || 'unknown-' + Date.now();
    clients.set(clientId, res);

    // Parse vehicle IDs from query parameter
    let vehicleIds = [];
    if (req.query.vehicleId) {
        // Support for legacy single vehicle parameter
        vehicleIds = [req.query.vehicleId];
    } else if (req.query.vehicleIds) {
        // Support for multiple vehicles as comma-separated list
        vehicleIds = req.query.vehicleIds.split(',').map(id => id.trim()).filter(id => id);
    }

    if (vehicleIds.length === 0) {
        res.write('data: {"error": "No vehicles selected"}\n\n');
        return;
    }

    // Create channel names for each vehicle
    const channels = vehicleIds.map(id => `vehicleUpdates:${id}`);
    clientSubscriptions.set(clientId, channels);

    console.log(`[SSE] Client ${clientId} subscribed to ${channels.length} vehicles: ${channels.join(', ')}`);

    // Subscribe to all requested vehicle channels that we're not already subscribed to
    const newSubscriptions = [];
    channels.forEach(channel => {
        if (!subscribedChannels.has(channel)) {
            subscribedChannels.add(channel);
            newSubscriptions.push(channel);
        }
    });

    // Batch subscribe to all new channels
    if (newSubscriptions.length > 0 && subscriber.status === 'ready') {
        subscriber.subscribe(...newSubscriptions).catch(err => {
            console.error(`[Redis] Failed to subscribe to channels:`, err);
            res.write(`data: {"error": "Failed to subscribe to some vehicle updates"}\n\n`);
        });
    }

    console.log("newSubscriptions",newSubscriptions)

    // Send initial confirmation with subscribed vehicles
    res.write(`data: ${JSON.stringify({
        status: "subscribed",
        subscribedVehicles: vehicleIds,
        timestamp: new Date().toISOString()
    })}\n\n`);

    req.on('close', () => {
        console.log(`[SSE] Client ${clientId} disconnected`);
        cleanupClient(clientId);
    });
});

// Endpoint to add/remove vehicle subscriptions for an existing connection
app.post('/events/update-subscription', (req, res) => {
    const clientId = req.body.clientId;
    const vehiclesToAdd = req.body.add || [];
    const vehiclesToRemove = req.body.remove || [];

    if (!clientId || !clients.has(clientId)) {
        return res.status(404).json({ error: 'Client connection not found' });
    }

    const currentChannels = clientSubscriptions.get(clientId) || [];
    const updatedChannels = [...currentChannels];

    // Add new vehicle subscriptions
    for (const vehicleId of vehiclesToAdd) {
        const channel = `vehicleUpdates:${vehicleId}`;
        if (!updatedChannels.includes(channel)) {
            updatedChannels.push(channel);
            if (!subscribedChannels.has(channel)) {
                subscribedChannels.add(channel);
                subscriber.subscribe(channel).catch(err => {
                    console.error(`[Redis] Failed to subscribe to ${channel}:`, err);
                });
            }
        }
    }

    // Remove vehicle subscriptions
    for (const vehicleId of vehiclesToRemove) {
        const channel = `vehicleUpdates:${vehicleId}`;
        const index = updatedChannels.indexOf(channel);
        if (index !== -1) {
            updatedChannels.splice(index, 1);

            // Check if this channel is still needed by other clients
            let stillInUse = false;
            clientSubscriptions.forEach((channels, id) => {
                if (id !== clientId && channels.includes(channel)) {
                    stillInUse = true;
                }
            });

            if (!stillInUse) {
                subscriber.unsubscribe(channel);
                subscribedChannels.delete(channel);
            }
        }
    }

    // Update client subscriptions
    clientSubscriptions.set(clientId, updatedChannels);

    // Notify client of subscription changes
    const client = clients.get(clientId);
    if (client) {
        try {
            client.write(`data: ${JSON.stringify({
                type: 'subscription_updated',
                subscribedVehicles: updatedChannels.map(ch => ch.split(':')[1]),
                timestamp: new Date().toISOString()
            })}\n\n`);
        } catch (err) {
            console.error(`[SSE] Error notifying client of subscription changes:`, err);
        }
    }

    return res.status(200).json({
        success: true,
        subscribedVehicles: updatedChannels.map(ch => ch.split(':')[1])
    });
});

// Health check with Redis status
app.get('/health', (req, res) => {
    const channelsByClient = {};
    clientSubscriptions.forEach((channels, clientId) => {
        channelsByClient[clientId] = channels;
    });

    res.json({
        status: 'healthy',
        activeClients: clients.size,
        totalSubscribedChannels: subscribedChannels.size,
        redisStatus: subscriber.status,
        subscribedChannels: Array.from(subscribedChannels),
        clientSubscriptions: channelsByClient
    });
});

// Graceful shutdown
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function gracefulShutdown() {
    console.log('Shutting down gracefully...');

    // Notify all clients
    const shutdownMessage = {
        type: 'shutdown',
        message: 'Server is shutting down',
        timestamp: new Date().toISOString()
    };

    clients.forEach((client) => {
        try {
            client.write(`data: ${JSON.stringify(shutdownMessage)}\n\n`);
            client.end();
        } catch (err) {
            console.error('[Shutdown] Error notifying client:', err);
        }
    });

    // Close Redis connection
    subscriber.quit().then(() => {
        console.log('[Redis] Connection closed cleanly');
        server.close(() => {
            console.log('[Server] HTTP server closed');
            process.exit(0);
        });
    }).catch(err => {
        console.error('[Redis] Error during connection close:', err);
        process.exit(1);
    });

    // Force exit after timeout
    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 5000);
}

// Start server
const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

