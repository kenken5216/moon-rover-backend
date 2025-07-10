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
  console.log('🤖 /api/ai/analyze-sensors route hit!'); // <-- LOG 1
  try {
    const { sensorData } = req.body;
    if (!sensorData) {
      console.error('❌ Error: sensorData is missing from the request body.');
      return res.status(400).json({ error: "sensorData is required" });
    }
    console.log('📊 Received sensorData:', JSON.stringify(sensorData, null, 2)); // <-- LOG 2

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
    console.log('📝 Generated prompt for Gemini.'); // <-- LOG 3

    console.log('🚀 Calling Gemini API...'); // <-- LOG 4
    const result = await model.generateContent(prompt);
    console.log('✅ Gemini API call successful.'); // <-- LOG 5

    const response = await result.response;
    const text = response.text();
    
    console.log('💡 Gemini Response received, sending to client.'); // <-- LOG 6
    res.json({ analysis: text });

  } catch (error) {
    // This will now catch errors from the model.generateContent call
    console.error("❌❌❌ CRITICAL ERROR in /api/ai/analyze-sensors:", error); // <-- LOG 7 (Error)
    res.status(500).json({ error: "Failed to get analysis from AI. Check backend logs for details." });
  }
});

// Endpoint to analyze an image from the video feed
app.post('/api/ai/analyze-image', async (req, res) => {
    console.log('🤖 /api/ai/analyze-image route hit!'); // <-- LOG 1
    try {
        const { imageData } = req.body;
        if (!imageData) {
            console.error('❌ Error: imageData is missing from the request body.');
            return res.status(400).json({ error: "imageData is required" });
        }
        console.log('🖼️ Received imageData (first 50 chars):', imageData.substring(0, 50)); // <-- LOG 2

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
        console.log('📝 Generated prompt for Gemini Vision.'); // <-- LOG 3

        console.log('🚀 Calling Gemini Vision API...'); // <-- LOG 4
        const result = await model.generateContent([prompt, ...imageParts]);
        console.log('✅ Gemini Vision API call successful.'); // <-- LOG 5

        const response = await result.response;
        const text = response.text();

        console.log('💡 Gemini Vision Response received, sending to client.'); // <-- LOG 6
        res.json({ analysis: text });

    } catch (error) {
        console.error("❌❌❌ CRITICAL ERROR in /api/ai/analyze-image:", error); // <-- LOG 7 (Error)
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