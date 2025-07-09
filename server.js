const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Will update this with your Cloudflare domain later
    methods: ["GET", "POST"]
  }
});

// Database connection (we'll set this up after Railway deployment)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());

// Store latest sensor data in memory for quick access
let latestSensorData = {
  roverId: "ROVER-001",
  lastUpdate: new Date(),
  status: "active",
  temperature: 1120,
  humidity: 45,
  airPressure: 1013,
  batteryLevel: 78,
  gpsCoordinates: {
    latitude: 25.033,
    longitude: 121.5654,
  },
  acceleration: {
    x: 0.12,
    y: -0.05,
    z: 9.81,
  },
  distanceSensor: 125,
  lightLevel: 450,
  connectionStatus: "connected",
};

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Rover Backend API is running!', 
    timestamp: new Date(),
    status: 'healthy'
  });
});

// API endpoint for Raspberry Pi to send sensor data
app.post('/api/sensors', async (req, res) => {
  try {
    const sensorData = req.body;
    console.log('Received sensor data:', sensorData);
    
    // For now, we'll skip database storage and just update memory
    // We'll add database later after Railway setup
    
    latestSensorData = {
      ...sensorData,
      lastUpdate: new Date(),
      status: "active",
      connectionStatus: "connected"
    };
    
    // Broadcast to all connected clients via WebSocket
    io.emit('sensorUpdate', latestSensorData);
    
    res.json({ 
      success: true, 
      message: 'Sensor data received successfully',
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Error processing sensor data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process sensor data' 
    });
  }
});

// API endpoint to get latest sensor data
app.get('/api/sensors/latest', (req, res) => {
  res.json({
    success: true,
    data: latestSensorData,
    timestamp: new Date()
  });
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send latest data immediately when client connects
  socket.emit('sensorUpdate', latestSensorData);
  
  // Handle client disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

function generateSensorData() {
  return {
    roverId: "ROVER-001",
    lastUpdate: new Date(),
    status: Math.random() > 0.1 ? "active" : "warning", // Sometimes show warning
    temperature: Math.round(1100 + Math.random() * 100), // 1100-1200
    humidity: Math.round(40 + Math.random() * 20),       // 40-60
    airPressure: Math.round(1000 + Math.random() * 30),  // 1000-1030
    batteryLevel: Math.round(70 + Math.random() * 30),   // 70-100
    gpsCoordinates: {
      latitude: 25.033 + (Math.random() - 0.5) * 0.01,   // Small variations
      longitude: 121.5654 + (Math.random() - 0.5) * 0.01,
    },
    acceleration: {
      x: (Math.random() - 0.5) * 0.5,   // -0.25 to 0.25
      y: (Math.random() - 0.5) * 0.5,   // -0.25 to 0.25
      z: 9.8 + (Math.random() - 0.5) * 0.2, // Around 9.8
    },
    distanceSensor: Math.round(100 + Math.random() * 50), // 100-150
    lightLevel: Math.round(400 + Math.random() * 100),    // 400-500
    connectionStatus: "connected",
  };
}

setInterval(() => {
  const sensorData = generateSensorData();
  latestSensorData = sensorData;
  
  // Broadcast to all connected clients
  io.emit('sensorUpdate', sensorData);
  console.log('📡 Broadcasting mock sensor data');
}, 1000); // Change this to adjust update frequency

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Rover Backend Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for real-time updates`);
});