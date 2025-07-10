// server.js (Complete and Final Version with AI Integration)

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
  gpsCoordinates: { latitude: 25.033, longitude: 121.5654 },
  acceleration: { x: 0, y: 0, z: 0 },
  distanceSensor: 0,
  lightLevel: 0,
  connectionStatus: "disconnected",
};

// Video stream related variables
let rtmpProcess = null;
let streamActive = false;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const HLS_PATH = '/tmp/hls';


// ===== STANDARD API ENDPOINTS (Unchanged) =====

// Health check endpoint
app.get('/', (req, res) => res.json({ message: 'Rover Backend API is running!', timestamp: new Date(), status: 'healthy' }));

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
app.get('/api/stream/status', (req, res) => res.json({ active: streamActive, rtmpUrl: `rtmp://${req.get('host') || 'localhost'}:${RTMP_PORT}/live/rover`, hlsUrl: `${req.protocol}://${req.get('host')}/api/stream/hls/rover.m3u8`, mjpegUrl: `${req.protocol}://${req.get('host')}/api/video-mjpeg` }));

// Other stream routes remain unchanged...


// ==================== 2. GEMINI AI API ENDPOINTS ====================

// Endpoint to analyze sensor data
app.post('/api/ai/analyze-sensors', async (req, res) => {
  try {
    const { sensorData } = req.body;
    if (!sensorData) {
      return res.status(400).json({ error: "sensorData is required" });
    }

    const prompt = `
      You are an expert AI Mission Control analyst for a lunar rover. Your task is to analyze the following real-time sensor data from the rover.
      Provide a concise, professional analysis in Traditional Chinese (繁體中文).
      Your response should be formatted in Markdown and include these sections:
      - **總結 (Summary):** A brief, one-sentence overview of the rover's current status.
      - **關鍵指標分析 (Key Metrics Analysis):** Analyze critical data points like battery, temperature, and connection. Highlight any values that are concerning or noteworthy.
      - **潛在風險 (Potential Risks):** Based on the data (e.g., low battery, high temp, unusual acceleration), identify potential risks.
      - **建議操作 (Recommended Actions):** Suggest 1-2 immediate actions for the mission operator.

      Here is the sensor data in JSON format:
      ${JSON.stringify(sensorData, null, 2)}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    res.json({ analysis: text });
  } catch (error) {
    console.error("Error in sensor analysis:", error);
    res.status(500).json({ error: "Failed to get analysis from AI" });
  }
});

// Endpoint to analyze an image from the video feed
app.post('/api/ai/analyze-image', async (req, res) => {
  try {
    const { imageData } = req.body; // Expects a Base64 data URL
    if (!imageData) {
      return res.status(400).json({ error: "imageData is required" });
    }

    // Convert Base64 data URL to a Gemini-compatible part
    const imageParts = [fileToGenerativePart(imageData)];
    
    const prompt = `
      You are an expert in lunar geology and rover engineering. Analyze this image captured by a lunar rover's forward-facing camera.
      Provide a concise, professional analysis in Traditional Chinese (繁體中文).
      Your response should be formatted in Markdown and include these sections:
      - **影像概述 (Image Overview):** Briefly describe what you see in the image (e.g., terrain, rocks, shadows).
      - **地質特徵 (Geological Features):** Identify any interesting rocks, soil (regolith) types, or geological formations.
      - **潛在危險 (Potential Hazards):** Point out any potential hazards for the rover, such as large rocks, steep slopes, deep shadows (which could hide obstacles), or soft sand.
      - **任務建議 (Mission Suggestions):** Based on the visual information, suggest a next step, like "proceed with caution," "safe to proceed," or "recommend analyzing the large rock on the left."
    `;

    const result = await model.generateContent([prompt, ...imageParts]);
    const response = await result.response;
    const text = response.text();

    res.json({ analysis: text });

  } catch (error) {
    console.error("Error in image analysis:", error);
    res.status(500).json({ error: "Failed to get analysis from AI" });
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


// ===== WEBSOCKET HANDLING (for real-time data) =====

io.on('connection', (socket) => {
  console.log('📱 Client connected:', socket.id);
  // Send the latest data to the new client immediately
  socket.emit('sensorUpdate', latestSensorData);

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
      batteryLevel: latestSensorData.batteryLevel, // Keep old value if not provided
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
  });
});

console.log('✅ Mock data generator is disabled. Waiting for real data from Pi.');

// ===== START SERVER =====
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Rover Backend Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for real-time updates`);
  console.log('🤖 Gemini AI analysis endpoints are active.');
});