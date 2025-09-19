// Importing Libraries
require('dotenv').config();
const express = require('express');
// const http = require('http');
const https = require('https');
const fs = require('fs');
const { createClient } = require('redis');
const { Server } = require('socket.io');

// Load SSL Cert + key
const options = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem')
};

// creating express app with Socket.IO
const app = express();
const server = https.createServer(options, app);
const io = new Server(server);

// Configurations
const PORT = process.env.PORT;
const REDIS_URL = process.env.REDIS_URL;

// Redis Keys / channels
const MESSAGE_LIST_KEY = process.env.MESSAGE_LIST_KEY; // Redis List for messages
const PUBSUB_CHANNEL = process.env.PUBSUB_CHANNEL; // Redis List for channels

// Static UI
app.use(express.static('public'));
app.use(express.json());

/* 
Create Redis clients: 
- one for general commands, 
- one for publishing, 
- one for subscribing

Note: With redis@4, you can duplicate a connected client for different roles.

*/

async function start() {
    // Redis Client Start
    const redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.log('Redis Client Error: ', err));
    
    await redisClient.connect();

    // A Separate client for Subscriber.
    const subClient = createClient({ url: REDIS_URL });
    subClient.on('error', (err) => console.log('Redis Sub Error:', err));

    const pubClient = createClient({ url: REDIS_URL });
    pubClient.on('error', (err) => console.log('Redis Pub Error:', err));

    await Promise.all([pubClient.connect(), subClient.connect()]);

    // Simple endpoint: return last N messages 
    app.get('/messages', async (req, res) => {
        try {
            // get last 50 messages, newest at the end
            const messages = await redisClient.lRange(MESSAGE_LIST_KEY, -50, -1);
            // store as JSONN Strings, parse them
            const parsed = messages.map((m) => JSON.parse(m));
            res.json(parsed);
        }
        catch (err) {
            console.log(err);
            res.status(500).json({ error: 'Failed to fetch messages' });
        }
    });

    // When server receives a Socket.IO Connection
    io.on('connection', (socket) => {
        console.log('Client Connected', socket.id);

        // Optionally, we can manage rooms or usernames;
        // here, we trust the client sends usernames with messages.
        socket.on('send_message', async (msgObj) => {
            /* 
            msgObj = 
            { username: 'Alice', 
                text: 'Hello',
                ts: 123456789
            }
            */
           try {
            // Validate Lightly
            if (!msgObj || !msgObj.username || !msgObj.text) return;

            // Making sure the time stamps exists
            msgObj.ts = msgObj.ts || Date.now();

            // Persist in Redis list (append to Right)
            await redisClient.rPush(MESSAGE_LIST_KEY, JSON.stringify(msgObj));
            // Trim list to last 500 messages to avoid unbounded growth
            await redisClient.lTrim(MESSAGE_LIST_KEY, -500, -1);

            // Publish to Redis Channel so other server instances (or this sever's subscriber)
            await pubClient.publish(PUBSUB_CHANNEL, JSON.stringify(msgObj));

            // Optionally, emit to the sending socket immediately (but publish/subscriber will will cause broadcast too)
            // socket.emit('message',msgObj);

           }
           catch (err) {
            console.log('Error Handling send_messages', err);
           }
        });
        
        // Disconnecting the socket connection
        socket.on('disconnect', () => {
            console.log('Client Disconnected', socket.id);
        });

    /*
        Subscribe to the Redis pubsub channel; 
        when a message arrives, broadcast to all connected sockets
    */
        
    });

    await subClient.subscribe(PUBSUB_CHANNEL, (messageStr) => {
        try {
            const msgObj = JSON.parse(messageStr);

            // broadcast to all the connected devices
            io.emit('message', msgObj);
        }
        catch (err) {
            console.log('Failed parsing the pubsub message', err);
        }
    });

    // Creating the Server
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Server listening on https://0.0.0.0:${PORT}`);
    });
}

start().catch((err) => {
    console.log('Failed to start server', err);
    process.exit(1);
});
