const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Configure this for production
    methods: ["GET", "POST"],
  },
});

app.use(express.json());
app.use(cors());

// Store active WebSocket connections by actionId
const activeConnections = new Map();

//Store callbacks temporarily for HTTP polling (iOS compatibility)
const callbackStorage = new Map();

//Store callback metadata for debugging and cleanup
const callbackMetadata = new Map();

//Auto-cleanup function for expired callbacks
function cleanupExpiredCallbacks() {
  const now = Date.now();
  const maxAge = 300000; // 5 minutes

  let cleanedCount = 0;

  for (const [actionId, metadata] of callbackMetadata.entries()) {
    if (now - metadata.timestamp > maxAge) {
      callbackStorage.delete(actionId);
      callbackMetadata.delete(actionId);
      cleanedCount++;
      console.log("🧹 Cleaned up expired callback:", actionId);
    }
  }

  if (cleanedCount > 0) {
    console.log(
      `🧹 Cleanup complete: removed ${cleanedCount} expired callbacks`
    );
  }
}

// Run cleanup every 2 minutes
setInterval(cleanupExpiredCallbacks, 120000);

// Socket connection handling
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // Register client with actionId
  socket.on("register", (actionId) => {
    console.log("📝 Registering client with actionId:", actionId);
    activeConnections.set(actionId, socket.id);
    console.log(
      "📋 Active WebSocket connections:",
      Array.from(activeConnections.keys())
    );

    // Also check if we have a stored callback for this actionId
    // (useful for cases where callback arrived before WebSocket reconnection)
    if (callbackStorage.has(actionId)) {
      console.log("🎯 Found stored callback for actionId:", actionId);
      const storedCallback = callbackStorage.get(actionId);

      // Send the stored callback immediately
      socket.emit("tronlink_callback", storedCallback);
      console.log("✅ Sent stored callback to reconnected client");

      // Clean up the stored callback
      callbackStorage.delete(actionId);
      callbackMetadata.delete(actionId);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
    // Remove from active connections
    for (let [actionId, socketId] of activeConnections.entries()) {
      if (socketId === socket.id) {
        activeConnections.delete(actionId);
        console.log(
          "🗑️ Removed actionId from active WebSocket connections:",
          actionId
        );
        break;
      }
    }
    console.log(
      "📋 Active WebSocket connections after cleanup:",
      Array.from(activeConnections.keys())
    );
  });
});

// Log ALL incoming requests
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.url} from ${req.ip}`);
  if (req.method === "POST" && req.body && Object.keys(req.body).length > 0) {
    console.log("📦 Request body:", JSON.stringify(req.body, null, 2));
  }
  if (req.method === "GET" && req.query && Object.keys(req.query).length > 0) {
    console.log("🔍 Query params:", req.query);
  }
  next();
});

//Callback endpoint with dual storage (WebSocket + HTTP polling)
app.all("/callback", (req, res) => {
  console.log("🎯 === CALLBACK RECEIVED ===");
  console.log("📦 Full request body:", JSON.stringify(req.body, null, 2));
  console.log("🔍 Request headers:", req.headers);

  const callbackData = req.body;
  const { actionId } = callbackData;

  console.log("🆔 Extracted actionId:", actionId);
  console.log(
    "📋 Current active WebSocket connections:",
    Array.from(activeConnections.keys())
  );
  console.log(
    "📦 Current stored callbacks:",
    Array.from(callbackStorage.keys())
  );

  if (!actionId) {
    console.error("❌ No actionId found in callback data");
    return res.status(400).json({ error: "actionId is required" });
  }

  // NEW: Always store the callback for HTTP polling (iOS compatibility)
  callbackStorage.set(actionId, callbackData);
  callbackMetadata.set(actionId, {
    timestamp: Date.now(),
    received: new Date().toISOString(),
    source: req.headers["user-agent"] || "unknown",
  });
  console.log("💾 Stored callback for HTTP polling access");

  // Try to send via WebSocket if connection exists
  if (activeConnections.has(actionId)) {
    const socketId = activeConnections.get(actionId);
    console.log("✅ Found matching WebSocket:", socketId);

    const socket = io.sockets.sockets.get(socketId);

    if (socket && socket.connected) {
      console.log("📤 Sending callback data to WebSocket client...");
      socket.emit("tronlink_callback", callbackData);
      console.log("✅ Successfully sent callback via WebSocket:", socketId);

      // Clean up WebSocket connection (but keep HTTP polling storage for a bit)
      activeConnections.delete(actionId);
      console.log("🗑️ Cleaned up WebSocket actionId:", actionId);
    } else {
      console.log("❌ WebSocket not found or disconnected");
      console.log("💾 Callback stored for HTTP polling retrieval");
    }
  } else {
    console.warn("⚠️ No active WebSocket connection for actionId:", actionId);
    console.log("💾 Callback stored for HTTP polling retrieval");
    console.log(
      "📋 Available WebSocket actionIds:",
      Array.from(activeConnections.keys())
    );
  }

  console.log("🎯 === CALLBACK PROCESSING COMPLETE ===\n");
  res.status(200).json({
    success: true,
    message: "Callback received and processed",
    actionId: actionId,
    storedForPolling: true,
  });
});

// HTTP polling endpoint for iOS compatibility
app.get("/check-callback/:actionId", (req, res) => {
  const { actionId } = req.params;
  console.log("🔍 HTTP polling request for actionId:", actionId);

  const callback = callbackStorage.get(actionId);
  const metadata = callbackMetadata.get(actionId);

  if (callback) {
    console.log("✅ Found stored callback for polling request");
    console.log("📊 Callback metadata:", metadata);

    // Send the callback data
    res.status(200).json({
      success: true,
      data: callback,
      metadata: {
        storedAt: metadata?.received,
        age: metadata ? Date.now() - metadata.timestamp : 0,
      },
    });

    // Clean up after successful retrieval
    callbackStorage.delete(actionId);
    callbackMetadata.delete(actionId);
    console.log(
      "🗑️ Cleaned up callback after HTTP polling retrieval:",
      actionId
    );
  } else {
    console.log("❌ No stored callback found for actionId:", actionId);
    res.status(404).json({
      success: false,
      message: "No callback found for this actionId",
      actionId: actionId,
      availableActionIds: Array.from(callbackStorage.keys()),
    });
  }
});

//  Bulk polling endpoint (for multiple pending actions)
app.post("/check-callbacks", (req, res) => {
  const { actionIds } = req.body;
  console.log("🔍 Bulk HTTP polling request for actionIds:", actionIds);

  if (!Array.isArray(actionIds)) {
    return res.status(400).json({ error: "actionIds must be an array" });
  }

  const results = {};
  const found = [];
  const notFound = [];

  for (const actionId of actionIds) {
    const callback = callbackStorage.get(actionId);
    const metadata = callbackMetadata.get(actionId);

    if (callback) {
      results[actionId] = {
        success: true,
        data: callback,
        metadata: {
          storedAt: metadata?.received,
          age: metadata ? Date.now() - metadata.timestamp : 0,
        },
      };
      found.push(actionId);

      // Clean up after retrieval
      callbackStorage.delete(actionId);
      callbackMetadata.delete(actionId);
    } else {
      results[actionId] = {
        success: false,
        message: "No callback found",
      };
      notFound.push(actionId);
    }
  }

  console.log(
    "✅ Bulk polling results - Found:",
    found.length,
    "Not found:",
    notFound.length
  );

  res.status(200).json({
    success: true,
    results: results,
    summary: {
      total: actionIds.length,
      found: found.length,
      notFound: notFound.length,
      foundActionIds: found,
      notFoundActionIds: notFound,
    },
  });
});

// Test endpoint to simulate TronLink callback
app.post("/test-callback", (req, res) => {
  console.log("🧪 Test callback triggered");
  const testData = {
    actionId: req.body.actionId || `test-${Date.now()}`,
    address: req.body.address || "TTest123456789",
    code: req.body.code || 0,
    id: req.body.id || 1,
    message: req.body.message || "success",
    transactionHash: req.body.transactionHash || "test-tx-hash",
    successful: req.body.successful !== undefined ? req.body.successful : true,
  };

  console.log("🧪 Test data:", testData);

  // Create a fake request object and process through callback endpoint
  const fakeReq = {
    body: testData,
    headers: { "user-agent": "test-client" },
    ip: req.ip,
  };

  // Process the test callback
  console.log("🎯 Processing test callback...");

  // Store for both WebSocket and HTTP polling
  callbackStorage.set(testData.actionId, testData);
  callbackMetadata.set(testData.actionId, {
    timestamp: Date.now(),
    received: new Date().toISOString(),
    source: "test-endpoint",
  });

  // Try WebSocket delivery
  if (activeConnections.has(testData.actionId)) {
    const socketId = activeConnections.get(testData.actionId);
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.connected) {
      socket.emit("tronlink_callback", testData);
      console.log("✅ Test callback sent via WebSocket");
    }
  }

  res.status(200).json({
    success: true,
    message: "Test callback processed",
    testData: testData,
    storedForPolling: true,
    activeConnections: Array.from(activeConnections.keys()),
  });
});

// Enhanced health check endpoint
app.get("/health", (req, res) => {
  const status = {
    status: "ok",
    timestamp: new Date().toISOString(),
    webSocket: {
      activeConnections: activeConnections.size,
      connectionIds: Array.from(activeConnections.keys()),
      socketCount: io.sockets.sockets.size,
    },
    httpPolling: {
      storedCallbacks: callbackStorage.size,
      callbackActionIds: Array.from(callbackStorage.keys()),
      oldestCallback: Array.from(callbackMetadata.values()).reduce(
        (oldest, current) => {
          return !oldest || current.timestamp < oldest.timestamp
            ? current
            : oldest;
        },
        null
      ),
    },
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
    },
  };
  console.log("🏥 Health check requested");
  res.status(200).json(status);
});

// Enhanced debug endpoint
app.get("/debug", (req, res) => {
  const debugInfo = {
    activeConnections: Object.fromEntries(activeConnections),
    socketIds: Array.from(io.sockets.sockets.keys()),
    storedCallbacks: Object.fromEntries(callbackStorage),
    callbackMetadata: Object.fromEntries(callbackMetadata),
    stats: {
      webSocketConnections: activeConnections.size,
      storedCallbacks: callbackStorage.size,
      totalSockets: io.sockets.sockets.size,
    },
  };

  console.log("🐛 Debug info requested");
  res.status(200).json(debugInfo);
});

// Manual cleanup endpoint (for development/testing)
app.post("/cleanup", (req, res) => {
  const beforeWebSocket = activeConnections.size;
  const beforeCallbacks = callbackStorage.size;

  // Clean up everything
  activeConnections.clear();
  callbackStorage.clear();
  callbackMetadata.clear();

  const result = {
    success: true,
    message: "Manual cleanup completed",
    cleaned: {
      webSocketConnections: beforeWebSocket,
      storedCallbacks: beforeCallbacks,
    },
  };

  console.log("🧹 Manual cleanup performed:", result);
  res.status(200).json(result);
});

// Statistics endpoint
app.get("/stats", (req, res) => {
  const stats = {
    current: {
      webSocketConnections: activeConnections.size,
      storedCallbacks: callbackStorage.size,
      connectedSockets: io.sockets.sockets.size,
    },
    callbackAges: Array.from(callbackMetadata.entries()).map(
      ([actionId, metadata]) => ({
        actionId,
        ageMs: Date.now() - metadata.timestamp,
        receivedAt: metadata.received,
      })
    ),
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    },
  };

  res.status(200).json(stats);
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
  console.log(`🚀  TronLink callback server running on port ${PORT}`);
  console.log(`📊 Features enabled:`);
  console.log(`   ✅ WebSocket callbacks (real-time)`);
  console.log(`   ✅ HTTP polling callbacks (iOS compatibility)`);
  console.log(`   ✅ Automatic callback cleanup (5min expiry)`);
  console.log(`   ✅ Bulk polling support`);
  console.log(`\n🔗 Available endpoints:`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Debug:  http://localhost:${PORT}/debug`);
  console.log(`   Stats:  http://localhost:${PORT}/stats`);
  console.log(`   Poll:   http://localhost:${PORT}/check-callback/:actionId`);
  console.log(`   Test:   POST http://localhost:${PORT}/test-callback`);
  console.log(`\n⏰ Cleanup runs every 2 minutes`);
});
