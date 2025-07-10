// server.js (Complete and Final Version with AI Integration + Car Control)

const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const { spawn } = require('child_process');
require('dotenv').config();

// ==================== 1. GEMINI AI SETUP ====================
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Check for API Key
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY environment variable not set. Please add it to your .env file.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
// =============================================================

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// IMPORTANT: Increase payload size limit for Base64 images
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory store for the latest sensor data
let latestSensorData = {
  roverId: "ROVER-001",
  lastUpdate: new Date(),
  status: "inactive",
  temperature: 0,
  humidity: 0,
  airPressure: 0,
  batteryLevel: 100,
  gpsCoordinates: { latitude: 22.189, longitude: 114.1037 },
  acceleration: { x: 0, y: 0, z: 0 },
  distanceSensor: 0,
  lightLevel: 0,
  connectionStatus: "disconnected",
};

// ==================== CAR CONTROL ADDITIONS ====================

// Store connected car clients
let connectedCars = new Map(); // Map<socketId, carInfo>

// Car control status
let carControlStatus = {
  totalCars: 0,
  activeCars: 0,
  lastCommand: null,
  lastCommandTime: null
};

// =============================================================

// Video stream related variables
let rtmpProcess = null;
let streamActive = false;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const HLS_PATH = '/tmp/hls';

// ===== STANDARD API ENDPOINTS (Unchanged) =====

// Health check endpoint
app.get('/', (req, res) => res.json({ 
  message: 'Rover Backend API is running!', 
  timestamp: new Date(), 
  status: 'healthy',
  carControl: {
    enabled: true,
    connectedCars: carControlStatus.totalCars
  }
}));

// API endpoint for Raspberry Pi to send sensor data (legacy/backup)
app.post('/api/sensors', async (req, res) => {
  try {
    const sensorData = req.body;
    latestSensorData = { ...sensorData, lastUpdate: new Date(), status: "active", connectionStatus: "connected" };
    io.emit('sensorUpdate', latestSensorData);
    res.json({ success: true, message: 'Sensor data received successfully', timestamp: new Date() });
  } catch (error) {
    console.error('Error processing sensor data:', error);
    res.status(500).json({ success: false, error: 'Failed to process sensor data' });
  }
});

// API endpoint to get latest sensor data for initial load
app.get('/api/sensors/latest', (req, res) => res.json({ success: true, data: latestSensorData, timestamp: new Date() }));

// Stream status endpoint
app.get('/api/stream/status', (req, res) => res.json({ 
  active: streamActive, 
  rtmpUrl: `rtmp://${req.get('host') || 'localhost'}:${RTMP_PORT}/live/rover`, 
  hlsUrl: `${req.protocol}://${req.get('host')}/api/stream/hls/rover.m3u8`, 
  mjpegUrl: `${req.protocol}://${req.get('host')}/api/video-mjpeg` 
}));

// ==================== CAR CONTROL API ENDPOINTS ====================

// Get car control status
app.get('/api/car/status', (req, res) => {
  res.json({
    success: true,
    data: {
      ...carControlStatus,
      connectedCars: Array.from(connectedCars.values())
    }
  });
});

// Send control command to all cars
app.post('/api/car/control', (req, res) => {
  try {
    const { command } = req.body;
    
    if (!command || !['f', 'b', 'l', 'r', 's', 'q'].includes(command)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid command. Use: f(forward), b(backward), l(left), r(right), s(stop), q(quit)' 
      });
    }

    // Update status
    carControlStatus.lastCommand = command;
    carControlStatus.lastCommandTime = new Date();

    // Send command to all connected cars via WebSocket
    io.emit('carControl', { command, timestamp: new Date() });

    console.log(`🚗 Car command sent: ${command} to ${connectedCars.size} cars`);

    res.json({ 
      success: true, 
      message: `Command '${command}' sent to ${connectedCars.size} car(s)`,
      command,
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Error sending car control command:', error);
    res.status(500).json({ success: false, error: 'Failed to send command' });
  }
});

// ================================================================

// ==================== 2. GEMINI AI API ENDPOINTS ====================

// Endpoint to analyze sensor data
app.post('/api/ai/analyze-sensors', async (req, res) => {
  console.log('🤖 /api/ai/analyze-sensors route hit!');
  try {
    const { sensorData } = req.body;
    if (!sensorData) {
      console.error('❌ Error: sensorData is missing from the request body.');
      return res.status(400).json({ error: "sensorData is required" });
    }
    console.log('📊 Received sensorData:', JSON.stringify(sensorData, null, 2));

    const prompt = `
      You are an expert AI Mission Control analyst for a lunar rover. Your task is to analyze the following real-time sensor data from the rover.
      Provide a concise, professional analysis in Traditional Chinese (繁體中文). You response and tone should be clean and clear, also you may use emoji for better struture.
      Your response should be formatted in Markdown and include these sections:
      - **總結 (Summary):** A brief, one-sentence overview of the rover's current status.
      - **關鍵指標分析 (Key Metrics Analysis):** Analyze critical data points like battery, temperature, and connection. Highlight any values that are concerning or noteworthy.
      - **潛在風險 (Potential Risks):** Based on the data (e.g., low battery, high temp, unusual acceleration), identify potential risks.
      - **建議操作 (Recommended Actions):** Suggest 1-2 immediate actions for the mission operator.

      Here is the sensor data in JSON format:
      ${JSON.stringify(sensorData, null, 2)}
    `;
    console.log('📝 Generated prompt for Gemini.');

    console.log('🚀 Calling Gemini API...');
    const result = await model.generateContent(prompt);
    console.log('✅ Gemini API call successful.');

    const response = await result.response;
    const text = response.text();
    
    console.log('💡 Gemini Response received, sending to client.');
    res.json({ analysis: text });

  } catch (error) {
    console.error("❌❌❌ CRITICAL ERROR in /api/ai/analyze-sensors:", error);
    res.status(500).json({ error: "Failed to get analysis from AI. Check backend logs for details." });
  }
});

// Endpoint to analyze an image from the video feed
app.post('/api/ai/analyze-image', async (req, res) => {
    console.log('🤖 /api/ai/analyze-image route hit!');
    try {
        const { imageData } = req.body;
        if (!imageData) {
            console.error('❌ Error: imageData is missing from the request body.');
            return res.status(400).json({ error: "imageData is required" });
        }
        console.log('🖼️ Received imageData (first 50 chars):', imageData.substring(0, 50));

        const imageParts = [fileToGenerativePart(imageData)];
        
        const prompt = `
          You are an expert in lunar geology and rover engineering. Analyze this image captured by a lunar rover's forward-facing camera.
          Provide a concise, professional analysis in Traditional Chinese (繁體中文). You response and tone should be clean and clear, also you may use emoji for better struture.
          Your response should be formatted in Markdown and include these sections:
          - **影像概述 (Image Overview):** Briefly describe what you see in the image (e.g., terrain, rocks, shadows).
          - **地質特徵 (Geological Features):** Identify any interesting rocks, soil (regolith) types, or geological formations.
          - **潛在危險 (Potential Hazards):** Point out any potential hazards for the rover.
          - **任務建議 (Mission Suggestions):** Based on the visual information, suggest a next step.
        `;
        console.log('📝 Generated prompt for Gemini Vision.');

        console.log('🚀 Calling Gemini Vision API...');
        const result = await model.generateContent([prompt, ...imageParts]);
        console.log('✅ Gemini Vision API call successful.');

        const response = await result.response;
        const text = response.text();

        console.log('💡 Gemini Vision Response received, sending to client.');
        res.json({ analysis: text });

    } catch (error) {
        console.error("❌❌❌ CRITICAL ERROR in /api/ai/analyze-image:", error);
        res.status(500).json({ error: "Failed to get analysis from AI. Check backend logs for details." });
    }
});

// ==================== 3. HELPER FUNCTION for AI ====================

// Converts a Base64 data URL (e.g., from canvas.toDataURL()) to a Gemini-compatible part.
function fileToGenerativePart(dataUrl) {
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid data URL format. Expected "data:mime/type;base64,..."');
  }
  return {
    inlineData: {
      data: match[2],
      mimeType: match[1],
    },
  };
}
// =====================================================================

// ===== WEBSOCKET HANDLING (for real-time data + car control) =====

io.on('connection', (socket) => {
  console.log('📱 Client connected:', socket.id);
  
  // Send the latest data to the new client immediately
  socket.emit('sensorUpdate', latestSensorData);
  socket.emit('carStatusUpdate', carControlStatus);

  // Handle car client registration
  socket.on('registerCar', (carInfo) => {
    connectedCars.set(socket.id, {
      ...carInfo,
      socketId: socket.id,
      connectedAt: new Date(),
      lastSeen: new Date()
    });
    
    carControlStatus.totalCars = connectedCars.size;
    carControlStatus.activeCars = connectedCars.size;
    
    console.log(`🚗 Car registered: ${carInfo.carId || socket.id}`);
    
    // Broadcast updated car status to all clients
    io.emit('carStatusUpdate', {
      ...carControlStatus,
      connectedCars: Array.from(connectedCars.values())
    });
  });

  // Handle car heartbeat
  socket.on('carHeartbeat', (data) => {
    if (connectedCars.has(socket.id)) {
      const carInfo = connectedCars.get(socket.id);
      carInfo.lastSeen = new Date();
      carInfo.status = data.status || 'active';
      connectedCars.set(socket.id, carInfo);
    }
  });

  // Broadcast video frames from Pi to all dashboard clients
  socket.on('videoFrame', (frameData) => {
    socket.broadcast.emit('videoFrame', frameData);
  });

  // Main handler for real-time sensor data from the Raspberry Pi
  socket.on('sensorData', (dataFromPi) => {
    // Basic validation
    if (!dataFromPi || !dataFromPi.device_id) {
      console.warn('⚠️ Received malformed sensorData packet:', dataFromPi);
      return;
    }

    const hasEnvData = dataFromPi.environmental && !dataFromPi.environmental.error;
    const hasMotionData = dataFromPi.motion && !dataFromPi.motion.error;
    
    // Transform Pi data into the structure the frontend expects
    const flattenedData = {
      roverId: dataFromPi.device_id,
      lastUpdate: new Date(dataFromPi.timestamp),
      status: "active",
      temperature: hasEnvData ? dataFromPi.environmental.temperature : latestSensorData.temperature,
      humidity: hasEnvData ? dataFromPi.environmental.humidity : latestSensorData.humidity,
      airPressure: hasEnvData ? dataFromPi.environmental.pressure : latestSensorData.airPressure,
      batteryLevel: latestSensorData.batteryLevel,
      gpsCoordinates: latestSensorData.gpsCoordinates,
      distanceSensor: latestSensorData.distanceSensor,
      lightLevel: latestSensorData.lightLevel,
      acceleration: hasMotionData ? {
        x: dataFromPi.motion.accelerometer.x,
        y: dataFromPi.motion.accelerometer.y,
        z: dataFromPi.motion.accelerometer.z,
      } : latestSensorData.acceleration,
      connectionStatus: "connected",
    };

    // Update the master server state
    latestSensorData = flattenedData;
    // Broadcast the new data to all connected dashboard clients
    io.emit('sensorUpdate', latestSensorData);
  });

  socket.on('disconnect', () => {
    console.log('📱 Client disconnected:', socket.id);
    
    // Remove car if it was registered
    if (connectedCars.has(socket.id)) {
      const carInfo = connectedCars.get(socket.id);
      console.log(`🚗 Car disconnected: ${carInfo.carId || socket.id}`);
      connectedCars.delete(socket.id);
      
      carControlStatus.totalCars = connectedCars.size;
      carControlStatus.activeCars = connectedCars.size;
      
      // Broadcast updated car status
      io.emit('carStatusUpdate', {
        ...carControlStatus,
        connectedCars: Array.from(connectedCars.values())
      });
    }
  });
});

console.log('✅ Mock data generator is disabled. Waiting for real data from Pi.');

// ===== START SERVER =====
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Rover Backend Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for real-time updates`);
  console.log('🤖 Gemini AI analysis endpoints are active.');
  console.log('🚗 Car control system initialized.');
});