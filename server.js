// Importing Libraries
require('dotenv').config();
const express = require('express');
// const http = require('http');
const https = require('https');
const fs = require('fs');
const { createClient } = require('redis');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');

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

// MySQL Config from .env
const MySQL_HOST = process.env.MySQL_HOST;
const MYSQL_PORT = process.env.MYSQL_PORT;
const MYSQL_USER = process.env.MYSQL_PORT;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE;

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

    // MySQL pool
    const pool = mysql.createPool({
        host: MySQL_HOST,
        port: MYSQL_PORT,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD,
        database: MYSQL_DATABASE,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    try {
        const createTableSql = `
        CREATE TABLE IF NOT EXISTS messages (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(256) NOT NULL,
            text TEXT NOT NULL,
            ts BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX (ts)
        ) ENGINE=InnoDB;
        `;

        await pool.query(createTableSql);
        console.log('MySQL: ensured messages messages table exists');

    } catch (err) {
        console.error('MySQL setup error:', err);
        // don't exit; we can continue but DB persistence will fail
    }


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
        const limit = Math.min(parseInt(req.query.limit || '50', 10 ), 500);
        const sql = `SELECT username, text, ts FROM messages ORDER BY ts DESC LIMIT ?`;
        const params = [Number(limit)];
        try {
            const [rows] = await pool.query(sql, params);

            // rows are newest first; reverse so that nerw messages comes first
            const parsed = rows.reverse().map(
                r => ({
                    username: r.username,
                    text: r.text,
                    ts: Number(r.ts)
                })
            );
            res.json(parsed);

        } catch (err) {
            console.log(err);
            res.status(500).json({
                error: 'Failed to fetch messages'
            })
        }
    });

    // When server receives a Socket.IO Connection
    io.on('connection', (socket) => {
        console.log('Client Connected', socket.id);

        // Send last 20 messages from MySQLto this socker only (history)
        (async () => {
            try {
                const historySql = `SELECT username, text, ts FROM messages  ORDER BY ts DESC LIMIT 20`;
                const [rows] = await pool.query(historySql);

                // Rows are newest first; so reversing it.
                const history = rows.reverse().map(
                    r => ({
                        username: r.username,
                        text: r.text,
                        ts: Number(r.ts)
                    })
                );

                if (history.length) {
                    socket.emit('history', history);
                }

            } catch (err) {
                console.log('Failed to fetch history for new client', err);
            }
        })();


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

                // Persist in MySQL
                try {
                    const insertSql = `INSERT INTO messages (username, text, ts) VALUES (?, ?, ?)`;
                    const insertParams = [msgObj.username, msgObj.text, Number(msgObj.ts)];

                    await pool.query(insertSql, insertParams);
                } catch (dbErr) {
                    console.log('MySQL insert Error:', dbErr)
                }

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
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`Server listening on https://127.0.0.1:${PORT}`);
    });
}

start().catch((err) => {
    console.log('Failed to start server', err);
    process.exit(1);
});
