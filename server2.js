// server.js - simple realtime chat using Socket.IO and Redis
const express = require('express');
const http = require('http');
const { createClient } = require('redis');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Config
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Redis keys / channel
const MESSAGES_LIST_KEY = 'chat:messages'; // Redis List to store recent messages
const PUBSUB_CHANNEL = 'chat:channel';

// Serve static UI
app.use(express.static('public'));
app.use(express.json());

// Create Redis clients: one for general commands, one for publishing, one for subscribing
// With redis@4, you can duplicate a connected client for different roles.
async function start() {
  const redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis Client Error', err));
  await redisClient.connect();

  // Use separate client for subscriber (recommended)
  const subClient = createClient({ url: REDIS_URL });
  subClient.on('error', (err) => console.error('Redis Sub Error', err));
  await subClient.connect();

  const pubClient = createClient({ url: REDIS_URL });
  pubClient.on('error', (err) => console.error('Redis Pub Error', err));
  await pubClient.connect();

  // Simple endpoint: return last N messages (frontend calls this on load)
  app.get('/messages', async (req, res) => {
    try {
      // get last 50 messages, newest at the end
      const messages = await redisClient.lRange(MESSAGES_LIST_KEY, -50, -1);
      // stored as JSON strings, parse them
      const parsed = messages.map((m) => JSON.parse(m));
      res.json(parsed);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // When server receives a socket.io connection
  io.on('connection', (socket) => {
    console.log('Client connected', socket.id);

    // Optionally you can manage rooms or usernames; here we trust the client sends username with the message.
    socket.on('send_message', async (msgObj) => {
      // msgObj = { username: 'Alice', text: 'hello', ts: 123456789 }
      try {
        // Validate lightly
        if (!msgObj || !msgObj.username || !msgObj.text) return;

        // make sure timestamp exists
        msgObj.ts = msgObj.ts || Date.now();

        // Persist in Redis list (append to right)
        await redisClient.rPush(MESSAGES_LIST_KEY, JSON.stringify(msgObj));
        // Trim list to last 500 messages to avoid unbounded growth
        await redisClient.lTrim(MESSAGES_LIST_KEY, -500, -1);

        // Publish to Redis channel so other server instances (or this server's subscriber) know
        await pubClient.publish(PUBSUB_CHANNEL, JSON.stringify(msgObj));

        // Optionally: emit to the sending socket immediately (but publish/subscriber will cause broadcast too)
        // socket.emit('message', msgObj);
      } catch (err) {
        console.error('Error handling send_message', err);
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected', socket.id);
    });
  });

  // Subscribe to the Redis pubsub channel; when a message arrives, broadcast to all connected sockets
  await subClient.subscribe(PUBSUB_CHANNEL, (messageStr) => {
    try {
      const msgObj = JSON.parse(messageStr);
      // broadcast to all connected clients
      io.emit('message', msgObj);
    } catch (err) {
      console.error('Failed to parse pubsub message', err);
    }
  });

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
