const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 增加限制以支援 Base64 圖像

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

// RTMP and HLS setup
let rtmpProcess = null;
let streamActive = false;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const HLS_PATH = '/tmp/hls';

// Video streaming clients storage
const videoStreamClients = new Map();
let mjpegClients = [];

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

// RTMP stream status endpoint
app.get('/api/stream/status', (req, res) => {
  res.json({
    active: streamActive,
    rtmpUrl: `rtmp://${req.get('host') || 'localhost'}:${RTMP_PORT}/live/rover`,
    hlsUrl: `${req.protocol}://${req.get('host')}/api/stream/hls/rover.m3u8`,
    videoStreamUrl: `${req.protocol}://${req.get('host')}/api/video-stream`,
    mjpegUrl: `${req.protocol}://${req.get('host')}/api/video-mjpeg`,
    base64Url: `${req.protocol}://${req.get('host')}/api/video-base64`,
    clients: {
      videoStream: videoStreamClients.size,
      mjpeg: mjpegClients.length,
      websocket: io.engine.clientsCount
    },
    timestamp: new Date()
  });
});

// Start RTMP to HLS conversion
app.post('/api/stream/start', (req, res) => {
  if (rtmpProcess) {
    return res.json({ 
      success: false, 
      message: 'Stream already active' 
    });
  }

  console.log('🎬 Starting RTMP to HLS conversion...');
  
  // FFmpeg command to convert RTMP to HLS
  rtmpProcess = spawn('ffmpeg', [
    '-f', 'flv',
    '-listen', '1',
    '-i', `rtmp://0.0.0.0:${RTMP_PORT}/live/rover`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments',
    `${HLS_PATH}/rover.m3u8`
  ]);

  rtmpProcess.stdout.on('data', (data) => {
    console.log(`📺 FFmpeg: ${data}`);
  });

  rtmpProcess.stderr.on('data', (data) => {
    console.log(`📺 FFmpeg: ${data}`);
  });

  rtmpProcess.on('close', (code) => {
    console.log(`📺 FFmpeg process exited with code ${code}`);
    streamActive = false;
    rtmpProcess = null;
  });

  streamActive = true;
  
  res.json({ 
    success: true, 
    message: 'RTMP server started',
    rtmpUrl: `rtmp://${req.get('host') || 'localhost'}:${RTMP_PORT}/live/rover`
  });
});

// Stop RTMP stream
app.post('/api/stream/stop', (req, res) => {
  if (rtmpProcess) {
    rtmpProcess.kill('SIGTERM');
    rtmpProcess = null;
    streamActive = false;
    console.log('🛑 RTMP stream stopped');
  }
  
  res.json({ 
    success: true, 
    message: 'Stream stopped' 
  });
});

// Serve HLS files
app.use('/api/stream/hls', express.static(HLS_PATH));

// ===== NEW BASE64 VIDEO STREAMING =====

// Base64 視頻端點（Pi 上傳 Base64 圖像）
app.post('/api/video-base64', (req, res) => {
  try {
    const { image, quality = 'good', timestamp } = req.body;
    
    if (!image) {
      return res.status(400).json({
        success: false,
        error: 'No image data provided'
      });
    }
    
    console.log('📹 Received Base64 frame from Pi, broadcasting...');
    
    // 通過 WebSocket 廣播 Base64 圖像到所有客戶端
    io.emit('videoFrame', {
      data: image,
      timestamp: timestamp || Date.now(),
      format: 'jpeg',
      quality: quality,
      source: 'pi'
    });
    
    res.json({ 
      success: true, 
      message: 'Base64 frame broadcasted via WebSocket',
      clients: io.engine.clientsCount,
      frameSize: image.length,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('📺 Base64 upload error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Base64 upload failed' 
    });
  }
});

// ===== VIDEO STREAMING ENDPOINTS =====

// HTTP Video Stream endpoint (for clients to receive video)
app.get('/api/video-stream', (req, res) => {
  console.log('📹 Video stream client connected');
  
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Transfer-Encoding': 'chunked'
  });

  // Store client connection
  const clientId = Date.now() + Math.random();
  videoStreamClients.set(clientId, res);
  
  req.on('close', () => {
    videoStreamClients.delete(clientId);
    console.log(`📺 Video client disconnected. Remaining: ${videoStreamClients.size}`);
  });

  req.on('error', () => {
    videoStreamClients.delete(clientId);
  });
});

// Video Upload endpoint (Pi uploads video chunks here)
app.post('/api/video-upload', (req, res) => {
  let totalChunkSize = 0;
  
  req.on('data', (chunk) => {
    totalChunkSize += chunk.length;
    
    // Immediately forward to all video stream clients
    videoStreamClients.forEach((client, clientId) => {
      try {
        client.write(chunk);
      } catch (error) {
        console.log(`📺 Removing disconnected video client ${clientId}:`, error.message);
        videoStreamClients.delete(clientId);
      }
    });
  });
  
  req.on('end', () => {
    res.json({ 
      success: true, 
      message: 'Video chunk received and forwarded',
      clients: videoStreamClients.size,
      chunkSize: totalChunkSize,
      timestamp: new Date()
    });
  });

  req.on('error', (error) => {
    console.error('📺 Video upload error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Video upload failed' 
    });
  });
});

// Alternative WebM video stream
app.get('/api/video-webm', (req, res) => {
  console.log('📹 WebM stream client connected');
  
  res.writeHead(200, {
    'Content-Type': 'video/webm',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Transfer-Encoding': 'chunked'
  });

  const clientId = 'webm_' + Date.now() + Math.random();
  videoStreamClients.set(clientId, res);
  
  req.on('close', () => {
    videoStreamClients.delete(clientId);
    console.log(`📺 WebM client disconnected. Remaining: ${videoStreamClients.size}`);
  });
});

// ===== WEBSOCKET HANDLING =====

io.on('connection', (socket) => {
  console.log('📱 Client connected:', socket.id);
  
  // Send latest data immediately when client connects
  socket.emit('sensorUpdate', latestSensorData);
  
  // 處理來自 Pi 的視頻幀（WebSocket 方式）
  socket.on('videoFrame', (frameData) => {
    console.log('📹 Received video frame via WebSocket from Pi, broadcasting...');
    // 廣播視頻幀到所有其他客戶端（除了發送者）
    socket.broadcast.emit('videoFrame', frameData);
  });
  
  // 處理來自前端的視頻請求
  socket.on('requestVideoStream', () => {
    console.log('📹 Client requested video stream');
    socket.emit('videoStreamReady', {
      message: 'Video stream ready',
      endpoints: {
        base64: '/api/video-base64',
        mjpeg: '/api/video-mjpeg',
        mp4: '/api/video-stream'
      }
    });
  });
  
  // Handle client disconnect
  socket.on('disconnect', () => {
    console.log('📱 Client disconnected:', socket.id);
  });
});

// ===== MJPEG ENDPOINTS (EXISTING) =====

// Simple MJPEG endpoint for fallback
app.get('/api/video-mjpeg', (req, res) => {
  console.log('📹 MJPEG client connected');
  
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  mjpegClients.push(res);
  
  req.on('close', () => {
    mjpegClients = mjpegClients.filter(client => client !== res);
    console.log(`📺 MJPEG client disconnected. Remaining: ${mjpegClients.length}`);
  });
});

// Receive MJPEG frames from Pi
app.post('/api/video-mjpeg', (req, res) => {
  let frameData = Buffer.alloc(0);
  
  req.on('data', (chunk) => {
    frameData = Buffer.concat([frameData, chunk]);
  });
  
  req.on('end', () => {
    // Broadcast frame to all MJPEG clients
    mjpegClients.forEach((client, index) => {
      try {
        client.write('--myboundary\r\n');
        client.write('Content-Type: image/jpeg\r\n');
        client.write(`Content-Length: ${frameData.length}\r\n\r\n`);
        client.write(frameData);
        client.write('\r\n');
      } catch (error) {
        console.log(`📺 Removing disconnected MJPEG client ${index}`);
        mjpegClients.splice(index, 1);
      }
    });
    
    res.json({ 
      success: true, 
      message: 'Frame received',
      clients: mjpegClients.length,
      frameSize: frameData.length
    });
  });
});

// ===== MOCK DATA GENERATION =====

function generateSensorData() {
  return {
    roverId: "ROVER-001",
    lastUpdate: new Date(),
    status: Math.random() > 0.1 ? "active" : "warning",
    temperature: Math.round(1100 + Math.random() * 100),
    humidity: Math.round(40 + Math.random() * 20),
    airPressure: Math.round(1000 + Math.random() * 30),
    batteryLevel: Math.round(70 + Math.random() * 30),
    gpsCoordinates: {
      latitude: 25.033 + (Math.random() - 0.5) * 0.01,
      longitude: 121.5654 + (Math.random() - 0.5) * 0.01,
    },
    acceleration: {
      x: (Math.random() - 0.5) * 0.5,
      y: (Math.random() - 0.5) * 0.5,
      z: 9.8 + (Math.random() - 0.5) * 0.2,
    },
    distanceSensor: Math.round(100 + Math.random() * 50),
    lightLevel: Math.round(400 + Math.random() * 100),
    connectionStatus: "connected",
  };
}

setInterval(() => {
  const sensorData = generateSensorData();
  latestSensorData = sensorData;
  
  // Broadcast to all connected clients
  io.emit('sensorUpdate', sensorData);
  console.log('📡 Broadcasting mock sensor data');
}, 1000);

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Rover Backend Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for real-time updates`);
  console.log(`🎬 RTMP streaming available on port ${RTMP_PORT}`);
  console.log(`📹 HTTP Video streaming available at /api/video-stream`);
  console.log(`📷 MJPEG streaming available at /api/video-mjpeg`);
  console.log(`🎯 Base64 WebSocket streaming available at /api/video-base64`);
});