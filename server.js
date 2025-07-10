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

// Database connection (remains the same)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware (remains the same)
app.use(cors());
app.use(express.json({ limit: '10mb' })); 

// Store latest sensor data in memory for quick access
// This now acts as our initial state or a fallback.
let latestSensorData = {
  roverId: "ROVER-001",
  lastUpdate: new Date(),
  status: "inactive", // Set initial status to inactive
  temperature: 0,
  humidity: 0,
  airPressure: 0,
  batteryLevel: 100, // Assume full battery initially
  gpsCoordinates: {
    latitude: 25.033,
    longitude: 121.5654,
  },
  acceleration: {
    x: 0,
    y: 0,
    z: 0,
  },
  distanceSensor: 0,
  lightLevel: 0,
  connectionStatus: "disconnected", // Start as disconnected
};

// All other setups (RTMP, video clients, etc.) remain the same.
let rtmpProcess = null;
let streamActive = false;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const HLS_PATH = '/tmp/hls';
const videoStreamClients = new Map();
let mjpegClients = [];

// Health check endpoint (remains the same)
app.get('/', (req, res) => {
  res.json({ 
    message: 'Rover Backend API is running!', 
    timestamp: new Date(),
    status: 'healthy'
  });
});

// API endpoint for Raspberry Pi to send sensor data (This is now a legacy/alternative method)
app.post('/api/sensors', async (req, res) => {
  try {
    const sensorData = req.body;
    console.log('Received sensor data via POST:', sensorData);
    
    latestSensorData = {
      ...sensorData,
      lastUpdate: new Date(),
      status: "active",
      connectionStatus: "connected"
    };
    
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

// API endpoint to get latest sensor data (remains the same)
app.get('/api/sensors/latest', (req, res) => {
  res.json({
    success: true,
    data: latestSensorData,
    timestamp: new Date()
  });
});

// All other API endpoints (/api/stream/status, /start, /stop, etc.) remain unchanged.
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

app.post('/api/stream/start', (req, res) => {
  if (rtmpProcess) {
    return res.json({ 
      success: false, 
      message: 'Stream already active' 
    });
  }
  console.log('🎬 Starting RTMP to HLS conversion...');
  rtmpProcess = spawn('ffmpeg', [
    '-f', 'flv', '-listen', '1', '-i', `rtmp://0.0.0.0:${RTMP_PORT}/live/rover`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '3',
    '-hls_flags', 'delete_segments', `${HLS_PATH}/rover.m3u8`
  ]);
  rtmpProcess.stdout.on('data', (data) => console.log(`📺 FFmpeg: ${data}`));
  rtmpProcess.stderr.on('data', (data) => console.log(`📺 FFmpeg: ${data}`));
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

app.use('/api/stream/hls', express.static(HLS_PATH));
app.post('/api/video-base64', (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ success: false, error: 'No image data provided' });
    console.log('📹 Received Base64 frame from Pi, broadcasting...');
    io.emit('videoFrame', { data: image, timestamp: Date.now(), source: 'pi' });
    res.json({ success: true, message: 'Base64 frame broadcasted' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Base64 upload failed' });
  }
});
// (other video streaming endpoints remain unchanged)

// ===== WEBSOCKET HANDLING =====

io.on('connection', (socket) => {
  console.log('📱 Client connected:', socket.id);
  
  // Send latest data immediately when client connects
  socket.emit('sensorUpdate', latestSensorData);
  
  // Handler for Base64 video from Pi
  socket.on('videoFrame', (frameData) => {
    // console.log('📹 Received video frame via WebSocket from Pi, broadcasting...'); // This can be noisy, optional to keep
    socket.broadcast.emit('videoFrame', frameData);
  });

  // ========== NEW SENSOR DATA HANDLER ==========
  socket.on('sensorData', (dataFromPi) => {
    
    // Check if the received data has the expected structure
    if (!dataFromPi || !dataFromPi.device_id || !dataFromPi.environmental || !dataFromPi.motion) {
      console.warn('⚠️ Received malformed sensorData packet:', dataFromPi);
      return;
    }

    // Check if environmental data exists and is not an error
    const hasEnvData = dataFromPi.environmental && !dataFromPi.environmental.error;
    
    // Check if motion data exists and is not an error
    const hasMotionData = dataFromPi.motion && !dataFromPi.motion.error;
    
    // Transform Pi data into the structure the frontend expects
    const flattenedData = {
      roverId: dataFromPi.device_id,
      lastUpdate: new Date(dataFromPi.timestamp),
      status: "active",
      
      // Safely access environmental data, otherwise keep the old value
      temperature: hasEnvData ? dataFromPi.environmental.temperature : latestSensorData.temperature,
      humidity: hasEnvData ? dataFromPi.environmental.humidity : latestSensorData.humidity,
      airPressure: hasEnvData ? dataFromPi.environmental.pressure : latestSensorData.airPressure,
      
      // Keep previous values for data not yet sent by the Pi
      batteryLevel: latestSensorData.batteryLevel,
      gpsCoordinates: latestSensorData.gpsCoordinates,
      distanceSensor: latestSensorData.distanceSensor,
      lightLevel: latestSensorData.lightLevel,
      
      // Safely access acceleration data, otherwise keep the old value
      acceleration: hasMotionData ? {
        x: dataFromPi.motion.accelerometer.x,
        y: dataFromPi.motion.accelerometer.y,
        z: dataFromPi.motion.accelerometer.z,
      } : latestSensorData.acceleration,

      connectionStatus: "connected",
    };

    // Update the master 'latestSensorData' object on the server
    latestSensorData = flattenedData;

    // Broadcast this newly formatted data to ALL connected frontends
    // using the existing 'sensorUpdate' event.
    io.emit('sensorUpdate', latestSensorData);
  });
  // ===========================================

  socket.on('disconnect', () => {
    console.log('📱 Client disconnected:', socket.id);
  });
});

// ===== MOCK DATA GENERATION (DISABLED) =====

// We are now disabling the mock data generator so it doesn't
// overwrite the real data coming from the Raspberry Pi.
/*
setInterval(() => {
  const sensorData = generateSensorData();
  latestSensorData = sensorData;
  
  // Broadcast to all connected clients
  io.emit('sensorUpdate', sensorData);
  console.log('📡 Broadcasting mock sensor data');
}, 1000);
*/
console.log('✅ Mock data generator is disabled. Waiting for real data from Pi.');


// Start the server (remains the same)
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Rover Backend Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for real-time updates`);
});