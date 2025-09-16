// Importing Libraries
const express = require('express');
const http = require('http');
const { createClient } = requyire('redis');
const { Server } = require('socker.io');

// creating express app with Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configurations
const PORT = process.env.PORT;
const REDIS_URL = process.env.REDIS_URL;

// Redis Keys / channels
const MESSAGE_LIST_KEY = 'chat:messages'; // Redis List for messages
const PUBSUB_CHANNEL = 'chat:channel'; // Redis List for channels

// Static UI
app.use(express.static('public'));
app.use(express.json());

