const express = require('express');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const app = express();
const PORT = 3000;

// Fun messages to send
const messages = [
  { emoji: '🚀', text: 'Launching rocket to Mars' },
  { emoji: '🎵', text: 'Playing your favorite song' },
  { emoji: '🌈', text: 'Rainbow detected in the sky' },
  { emoji: '☕', text: 'Brewing fresh coffee' },
  { emoji: '🎮', text: 'Game level completed' },
  { emoji: '📚', text: 'Loading next chapter' },
  { emoji: '🌟', text: 'New achievement unlocked' },
  { emoji: '🍕', text: 'Pizza delivery on the way' },
  { emoji: '🎨', text: 'Masterpiece created' },
  { emoji: '🔔', text: 'Notification received' },
  { emoji: '⚡', text: 'Power surge detected' },
  { emoji: '🎯', text: 'Target acquired' },
  { emoji: '🌙', text: 'Night mode activated' },
  { emoji: '🎪', text: 'Circus coming to town' },
  { emoji: '🏆', text: 'Trophy awarded' }
];

// Serve static files
app.use(express.static('.'));
app.use('/static', express.static('static'));

// Store all sent events with their IDs (for replay on reconnect)
const eventHistory = [];
let globalEventCounter = 0;

// Track active connections for manual control
const activeConnections = new Map();
let connectionIdCounter = 0;

// Event generation management
let eventGenerationInterval = null;

// Function to generate a single event
function generateEvent() {
  // Generate random event ID
  const eventId = crypto.randomBytes(8).toString('hex');

  // Get a random message
  const randomMsg = messages[Math.floor(Math.random() * messages.length)];

  // Increment global counter
  globalEventCounter++;

  const data = {
    message: `${randomMsg.emoji} ${randomMsg.text}`,
    timestamp: new Date().toISOString(),
    eventNumber: globalEventCounter
  };

  // Store event in history for replay
  eventHistory.push({ id: eventId, data });

  console.log(`Generated event #${globalEventCounter} [ID: ${eventId}]: ${randomMsg.text}`);

  // Keep only last 100 events to prevent memory issues
  if (eventHistory.length > 100) {
    eventHistory.shift();
  }
}

// Start event generation when first retry demo client connects
function startEventGeneration() {
  if (!eventGenerationInterval) {
    console.log('🚀 Starting event generation (retry demo client connected)');
    eventGenerationInterval = setInterval(generateEvent, 2000);
  }
}

// Stop event generation when last retry demo client disconnects
function stopEventGeneration() {
  if (eventGenerationInterval) {
    console.log('⏹️  Stopping event generation (no retry demo clients connected)');
    clearInterval(eventGenerationInterval);
    eventGenerationInterval = null;
  }
}

// Endpoint to manually start event generation
app.post('/start-event-generation', (_req, res) => {
  startEventGeneration();
  res.json({ message: 'Event generation started' });
});

// Endpoint to manually stop event generation
app.post('/stop-event-generation', (_req, res) => {
  if (eventGenerationInterval) {
    console.log('🛑 Stopping event generation (manual request)');
    clearInterval(eventGenerationInterval);
    eventGenerationInterval = null;
  }
  res.status(204).end(); // No content response for sendBeacon
});

// Endpoint to force close a connection (with or without retry)
app.post('/control/close/:connectionId/:mode', (req, res) => {
  const { connectionId, mode } = req.params;
  const connection = activeConnections.get(connectionId);

  if (connection) {
    console.log(`Closing connection ${connectionId} with mode: ${mode}`);

    // Note: Headers are already sent for SSE connections, so we can only close the stream
    // We cannot change the HTTP status code after headers are sent
    if (mode === 'no-retry') {
      // Try to signal "no reconnect" by sending a special event before closing
      // Note: Most browsers ignore this and will reconnect anyway
      try {
        connection.res.write(`event: close\n`);
        connection.res.write(`data: {"reason": "no-retry"}\n\n`);
      } catch (err) {
        console.log('Error writing close event:', err.message);
      }
      connection.res.end();
    } else if (mode === 'server-close') {
      // Just close normally - client will reconnect
      connection.res.end();
    }
    activeConnections.delete(connectionId);
    // Don't decrement counter or stop event generation - keep events running
    // activeRetryDemoConnections--;
    res.json({ message: `Connection ${connectionId} closed with mode: ${mode}` });
  } else {
    res.status(404).json({ error: 'Connection not found' });
  }
});

// Get list of active connections
app.get('/control/connections', (req, res) => {
  const connections = Array.from(activeConnections.values()).map(c => ({
    id: c.id,
    connectedAt: c.connectedAt
  }));
  res.json(connections);
});

// SSE endpoint with configurable retry
app.get('/events', (req, res) => {
  // Get retry interval from query parameter (default: 3000ms)
  const retryInterval = parseInt(req.query.retry) || 3000;

  // Get last event ID from header (for reconnections)
  const lastEventId = req.headers['last-event-id'];

  // Assign connection ID
  const connectionId = `conn_${++connectionIdCounter}`;

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  console.log(`[${connectionId}] Client connected. Retry interval: ${retryInterval}ms${lastEventId ? `, Resuming from ID: ${lastEventId}` : ''}`);

  // Start event generation (will only start if not already running)
  startEventGeneration();

  // Store this connection for remote control
  activeConnections.set(connectionId, {
    id: connectionId,
    res,
    connectedAt: new Date().toISOString()
  });

  // Send initial retry header
  res.write(`retry: ${retryInterval}\n\n`);

  // Send connection ID as first event
  res.write(`event: connection\n`);
  res.write(`data: ${JSON.stringify({ connectionId })}\n\n`);

  // Determine which events to send
  let eventsToSend = [];

  if (lastEventId) {
    // Client is reconnecting - find events after lastEventId
    const lastEventIndex = eventHistory.findIndex(e => e.id === lastEventId);
    if (lastEventIndex !== -1) {
      eventsToSend = eventHistory.slice(lastEventIndex + 1);
      console.log(`Client reconnecting. Sending ${eventsToSend.length} accumulated events since event #${eventHistory[lastEventIndex].data.eventNumber}`);
    } else {
      // lastEventId not found in history (too old), send all available
      eventsToSend = eventHistory;
      console.log(`Client reconnecting with old ID. Sending all ${eventsToSend.length} events in history`);
    }
  } else {
    // New client - send all accumulated events
    eventsToSend = eventHistory;
    console.log(`New client connected. Sending all ${eventsToSend.length} accumulated events`);
  }

  // Send all accumulated events immediately
  eventsToSend.forEach(event => {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  });

  // Track the last event sent to this client
  let lastSentEventNumber = eventsToSend.length > 0 ? eventsToSend[eventsToSend.length - 1].data.eventNumber : 0;

  // Send new events as they are generated
  const intervalId = setInterval(() => {
    // Check if there are new events since we last sent
    const newEvents = eventHistory.filter(e => e.data.eventNumber > lastSentEventNumber);

    newEvents.forEach(event => {
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      console.log(`Sent event #${event.data.eventNumber} [ID: ${event.id}] to client`);
      lastSentEventNumber = event.data.eventNumber;
    });
  }, 500); // Check for new events every 500ms

  // Cleanup on client disconnect
  req.on('close', () => {
    console.log(`[${connectionId}] Client disconnected`);
    clearInterval(intervalId);
    activeConnections.delete(connectionId);
    // Don't stop event generation on disconnect - keep it running
    // activeRetryDemoConnections--;
    // stopEventGeneration();
  });
});

// SSE endpoint with Content-Length (sends pre-built SSE response)
app.get('/events-content-length', (req, res) => {
  // Get retry interval from query parameter (default: 3000ms)
  const retryInterval = parseInt(req.query.retry) || 3000;

  // Build the entire SSE response upfront
  let sseData = `retry: ${retryInterval}\n\n`;

  // Add connection event
  const connectionId = `conn_${++connectionIdCounter}`;
  sseData += `event: connection\n`;
  sseData += `data: ${JSON.stringify({ connectionId })}\n\n`;

  // Add all accumulated events
  eventHistory.forEach(event => {
    sseData += `id: ${event.id}\n`;
    sseData += `data: ${JSON.stringify(event.data)}\n\n`;
  });

  // Add a final message
  sseData += `event: info\n`;
  sseData += `data: ${JSON.stringify({ message: 'This response used Content-Length instead of chunked encoding' })}\n\n`;

  console.log(`[${connectionId}] Client connected to Content-Length endpoint. Sending ${eventHistory.length} events`);

  // Set headers for SSE with Content-Length
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Length', Buffer.byteLength(sseData));

  // Send the complete response
  res.write(sseData);
  res.end();
});

// SSE endpoint with Connection: close (server tells client to close connection)
app.get('/events-connection-close-server', (req, res) => {
  // Get retry interval from query parameter (default: 3000ms)
  const retryInterval = parseInt(req.query.retry) || 3000;

  // Build the entire SSE response upfront
  let sseData = `retry: ${retryInterval}\n\n`;

  // Add connection event
  const connectionId = `conn_${++connectionIdCounter}`;
  sseData += `event: connection\n`;
  sseData += `data: ${JSON.stringify({ connectionId })}\n\n`;

  // Add all accumulated events
  eventHistory.forEach(event => {
    sseData += `id: ${event.id}\n`;
    sseData += `data: ${JSON.stringify(event.data)}\n\n`;
  });

  // Add a final message
  sseData += `event: info\n`;
  sseData += `data: ${JSON.stringify({ message: 'This response used Connection: close header (server-initiated)' })}\n\n`;

  console.log(`[${connectionId}] Client connected to Connection: close (server) endpoint. Sending ${eventHistory.length} events`);

  // Set headers for SSE with Connection: close (server tells client to close)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.setHeader('Content-Length', Buffer.byteLength(sseData));

  // Send the complete response
  res.write(sseData);
  res.end();
});

// SSE endpoint that disables chunked encoding and doesnt use content-length (experimental - may not work as expected)
app.get('/events-no-headers', (req, res) => {
  // Get retry interval from query parameter (default: 3000ms)
  const retryInterval = parseInt(req.query.retry) || 3000;

  // Get last event ID from header (for reconnections)
  const lastEventId = req.headers['last-event-id'];

  // Assign connection ID
  const connectionId = `conn_${++connectionIdCounter}`;

  // Try to disable chunked encoding by setting chunkedEncoding to false
  res.chunkedEncoding = false;

  // Set only the required SSE headers - trying to avoid both Content-Length and chunked encoding
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  // Explicitly try to prevent chunked encoding
  res.setHeader('Transfer-Encoding', 'identity');

  console.log(`[${connectionId}] Client connected to no-headers endpoint. Retry interval: ${retryInterval}ms${lastEventId ? `, Resuming from ID: ${lastEventId}` : ''}`);

  // Start event generation (will only start if not already running)
  startEventGeneration();

  // Store this connection for remote control
  activeConnections.set(connectionId, {
    id: connectionId,
    res,
    connectedAt: new Date().toISOString()
  });

  // Send initial retry header
  res.write(`retry: ${retryInterval}\n\n`);

  // Send connection ID as first event
  res.write(`event: connection\n`);
  res.write(`data: ${JSON.stringify({ connectionId })}\n\n`);

  // Send info message
  res.write(`event: info\n`);
  res.write(`data: ${JSON.stringify({ message: 'Attempting to disable chunked encoding - connection will stay open until closed' })}\n\n`);

  // Determine which events to send
  let eventsToSend = [];

  if (lastEventId) {
    // Client is reconnecting - find events after lastEventId
    const lastEventIndex = eventHistory.findIndex(e => e.id === lastEventId);
    if (lastEventIndex !== -1) {
      eventsToSend = eventHistory.slice(lastEventIndex + 1);
      console.log(`Client reconnecting. Sending ${eventsToSend.length} accumulated events since event #${eventHistory[lastEventIndex].data.eventNumber}`);
    } else {
      // lastEventId not found in history (too old), send all available
      eventsToSend = eventHistory;
      console.log(`Client reconnecting with old ID. Sending all ${eventsToSend.length} events in history`);
    }
  } else {
    // New client - send all accumulated events
    eventsToSend = eventHistory;
    console.log(`New client connected. Sending all ${eventsToSend.length} accumulated events`);
  }

  // Send all accumulated events immediately
  eventsToSend.forEach(event => {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  });

  // Track the last event sent to this client
  let lastSentEventNumber = eventsToSend.length > 0 ? eventsToSend[eventsToSend.length - 1].data.eventNumber : 0;

  // Send new events as they are generated
  const intervalId = setInterval(() => {
    // Check if there are new events since we last sent
    const newEvents = eventHistory.filter(e => e.data.eventNumber > lastSentEventNumber);

    newEvents.forEach(event => {
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      console.log(`Sent event #${event.data.eventNumber} [ID: ${event.id}] to no-headers client`);
      lastSentEventNumber = event.data.eventNumber;
    });
  }, 500); // Check for new events every 500ms

  // Cleanup on client disconnect
  req.on('close', () => {
    console.log(`[${connectionId}] No-headers client disconnected`);
    clearInterval(intervalId);
    activeConnections.delete(connectionId);
    // Don't stop event generation on disconnect - keep it running
    // activeRetryDemoConnections--;
    // stopEventGeneration();
  });
});

// SSE endpoint with no Content-Length and no chunked encoding (sends then closes)
app.get('/events-send-and-close', (req, res) => {
  // Get retry interval from query parameter (default: 3000ms)
  const retryInterval = parseInt(req.query.retry) || 3000;

  // Assign connection ID
  const connectionId = `conn_${++connectionIdCounter}`;

  // Disable chunked encoding
  res.chunkedEncoding = false;

  // Set headers - no Content-Length, trying to disable chunked encoding
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'identity');

  console.log(`[${connectionId}] Client connected to send-and-close endpoint. Sending ${eventHistory.length} events then closing`);

  // Send retry header
  res.write(`retry: ${retryInterval}\n\n`);

  // Send connection event
  res.write(`event: connection\n`);
  res.write(`data: ${JSON.stringify({ connectionId })}\n\n`);

  // Send all accumulated events
  eventHistory.forEach(event => {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  });

  // Send info message
  res.write(`event: info\n`);
  res.write(`data: ${JSON.stringify({ message: 'No chunked encoding, no Content-Length - sending all events then closing' })}\n\n`);

  // Close the connection
  res.end();
});

// ====================================
// API Endpoints (from migrated Go app)
// ====================================

// 1. /api/hello - Returns JSON with application information
app.get('/api/hello', (req, res) => {
  const id = crypto.randomUUID();

  res.json({
    id: id,
    message: 'Hello from Express!',
    status: 'success',
    data: {
      framework: 'Express + Node.js',
      version: '1.0.0'
    }
  });
});

// 2. /api/slow - Simulates a slow API response (2-second delay)
app.get('/api/slow', (req, res) => {
  const id = req.query.id || 'unknown';
  const requestId = crypto.randomUUID();

  console.log(`[Slow API] Request ${id} started at ${new Date().toISOString()}`);

  setTimeout(() => {
    console.log(`[Slow API] Request ${id} completed at ${new Date().toISOString()}`);

    res.json({
      id: requestId,
      message: `Slow response for request ${id}`,
      status: 'success',
      timestamp: new Date().toISOString()
    });
  }, 2000);
});

// 3. /api/close-delimited - HTTP response without Content-Length (connection close delimited)
app.get('/api/close-delimited', (req, res) => {
  // We need to use the raw socket to control headers precisely
  const socket = req.socket;

  // Build the response manually
  const body = `This response is delimited by connection close.\n\nNo Content-Length header is sent.\nNo chunked encoding is used.\nThe end of the response is indicated by the server closing the connection.\n\nThis demonstrates an alternative HTTP response completion mechanism.`;

  // Write raw HTTP response
  socket.write('HTTP/1.1 200 OK\r\n');
  socket.write('Content-Type: text/plain\r\n');
  socket.write('Connection: close\r\n');
  socket.write('\r\n');
  socket.write(body);
  socket.end();
});

// /api/http11-demo - HTTP/1.1 with Content-Length and Connection: close
app.get('/api/http11-demo', (req, res) => {
  const count = parseInt(req.query.count) || 1;
  const requestId = crypto.randomUUID();

  console.log(`[HTTP/1.1 Demo] Request ${count} received at ${new Date().toISOString()}`);

  // Build JSON response
  const responseData = {
    id: requestId,
    message: `HTTP/1.1 response #${count}`,
    status: 'success',
    timestamp: new Date().toISOString(),
    headers: {
      contentLength: 'calculated and sent',
      connection: 'close'
    },
    description: 'This response uses HTTP/1.1 with explicit Content-Length and Connection: close headers'
  };

  const body = JSON.stringify(responseData, null, 2);

  // Set headers explicitly
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Connection', 'close');

  console.log(`[HTTP/1.1 Demo] Sending response #${count} with Content-Length: ${Buffer.byteLength(body)}`);

  // Send response and close connection
  res.send(body);
});

// ====================================
// Additional SSE Endpoints (from migrated Go app)
// ====================================

// 4. /sse/single - Sends a single SSE message
app.get('/sse/single', (req, res) => {
  const messageId = crypto.randomUUID();

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  console.log(`[SSE Single] Sending single message with ID: ${messageId}`);

  // Send a single message
  const data = {
    id: messageId,
    message: 'Single SSE message from Express',
    timestamp: new Date().toISOString(),
    count: 1
  };

  res.write(`id: ${messageId}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Close the connection after sending one message
  res.end();
});

// 5. /sse/multiple - Sends 10 SSE messages with delays
app.get('/sse/multiple', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  console.log('[SSE Multiple] Client connected, will send 10 messages');

  let count = 0;
  const maxCount = 10;

  const sendMessage = () => {
    count++;
    const messageId = crypto.randomUUID();

    const data = {
      id: messageId,
      message: `SSE message ${count} of ${maxCount}`,
      timestamp: new Date().toISOString(),
      count: count
    };

    res.write(`id: ${messageId}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);

    console.log(`[SSE Multiple] Sent message ${count}/${maxCount}`);

    if (count < maxCount) {
      setTimeout(sendMessage, 500);
    } else {
      res.end();
    }
  };

  // Start sending messages
  sendMessage();

  // Cleanup on client disconnect
  req.on('close', () => {
    console.log('[SSE Multiple] Client disconnected');
  });
});

// 6. /sse/compressed - Sends 10 SSE messages with gzip-compressed, base64-encoded payloads
app.get('/sse/compressed', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  console.log('[SSE Compressed] Client connected, will send 10 compressed messages');

  let count = 0;
  const maxCount = 10;

  const sendMessage = () => {
    count++;
    const messageId = crypto.randomUUID();

    // Create a large payload with repetitive data (good for compression)
    const largePayload = {
      id: messageId,
      message: `Compressed message ${count} of ${maxCount}`,
      timestamp: new Date().toISOString(),
      count: count,
      // Add repetitive data to demonstrate compression
      data: Array(100).fill({
        field1: 'This is repetitive data that compresses well',
        field2: 'More repetitive content here',
        field3: 'Even more repeated information',
        number: count
      })
    };

    const originalJson = JSON.stringify(largePayload);
    const originalSize = Buffer.byteLength(originalJson);

    // Compress the payload
    const compressed = zlib.gzipSync(originalJson);
    const compressedSize = compressed.length;

    // Base64 encode the compressed data
    const base64Compressed = compressed.toString('base64');

    // Send the event with compression metadata
    const eventData = {
      messageId: messageId,
      compressed: true,
      payload: base64Compressed,
      originalSize: originalSize,
      compressedSize: compressedSize,
      compressionRatio: (compressedSize / originalSize * 100).toFixed(2) + '%'
    };

    res.write(`id: ${messageId}\n`);
    res.write(`data: ${JSON.stringify(eventData)}\n\n`);

    console.log(`[SSE Compressed] Sent message ${count}/${maxCount} (${originalSize}B -> ${compressedSize}B, ratio: ${eventData.compressionRatio})`);

    if (count < maxCount) {
      setTimeout(sendMessage, 500);
    } else {
      res.end();
    }
  };

  // Start sending messages
  sendMessage();

  // Cleanup on client disconnect
  req.on('close', () => {
    console.log('[SSE Compressed] Client disconnected');
  });
});

// 7. /sse/single-no-chunked - Sends a single SSE message without chunked encoding
app.get('/sse/single-no-chunked', (req, res) => {
  console.log('[SSE Single No Chunked] Client connected, preparing single message');

  // We need to use the raw socket to control encoding
  const socket = req.socket;

  // Build SSE message upfront
  const messageId = crypto.randomUUID();
  const data = {
    id: messageId,
    message: 'Single SSE message (no chunked encoding)',
    timestamp: new Date().toISOString(),
    count: 1
  };

  let sseData = '';
  sseData += `id: ${messageId}\n`;
  sseData += `data: ${JSON.stringify(data)}\n\n`;

  // Write raw HTTP response without chunked encoding
  socket.write('HTTP/1.1 200 OK\r\n');
  socket.write('Content-Type: text/event-stream\r\n');
  socket.write('Cache-Control: no-cache\r\n');
  socket.write('Connection: close\r\n');
  socket.write('Access-Control-Allow-Origin: *\r\n');
  socket.write('\r\n');
  socket.write(sseData);
  socket.end();

  console.log('[SSE Single No Chunked] Sent single message and closed connection');
});

// 8. /sse/multiple-no-chunked - Sends 10 SSE messages without chunked encoding
app.get('/sse/multiple-no-chunked', (req, res) => {
  console.log('[SSE No Chunked] Client connected, will send 10 messages with delays');

  // We need to use the raw socket to control encoding
  const socket = req.socket;

  // Disable Nagle's algorithm FIRST to send data immediately
  socket.setNoDelay(true);

  // Write raw HTTP response headers without chunked encoding
  socket.write('HTTP/1.1 200 OK\r\n');
  socket.write('Content-Type: text/event-stream\r\n');
  socket.write('Cache-Control: no-cache\r\n');
  socket.write('Access-Control-Allow-Origin: *\r\n');
  socket.write('\r\n');

  let count = 0;
  const maxCount = 10;

  const sendMessage = () => {
    count++;
    const messageId = crypto.randomUUID();
    const data = {
      id: messageId,
      message: `SSE message ${count} of ${maxCount} (no chunked encoding)`,
      timestamp: new Date().toISOString(),
      count: count
    };

    const sseMessage = `id: ${messageId}\ndata: ${JSON.stringify(data)}\n\n`;
    socket.write(sseMessage);

    console.log(`[SSE No Chunked] Sent message ${count}/${maxCount}`);

    if (count < maxCount) {
      setTimeout(sendMessage, 500);
    } else {
      socket.end();
      console.log('[SSE No Chunked] Sent all messages and closed connection');
    }
  };

  // Start sending messages
  sendMessage();
});

// 9. /api/variable-chunks - Sends variable-sized chunks using chunked transfer encoding
app.get('/api/variable-chunks', (req, res) => {
  // Set headers for chunked encoding (no Content-Length)
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Don't set Content-Length - Express will use chunked encoding automatically

  console.log('[Variable Chunks] Client connected, will send variable-sized chunks');

  let count = 0;
  const maxCount = 5;
  const chunks = [];

  const sendChunk = () => {
    count++;
    const chunkId = crypto.randomUUID();

    // Generate variable-sized payload
    // Size increases very gradually: 1, 2, 3, 4, 5 items
    const sizes = [1, 2, 3, 4, 5];
    const dataSize = sizes[count - 1] || 5;

    // Create random data of varying size
    const randomData = Array(dataSize).fill(null).map((_, i) => ({
      index: i,
      randomValue: Math.random(),
      text: `Item ${i} in chunk ${count}`,
      emoji: messages[i % messages.length].emoji
    }));

    const chunk = {
      chunkNumber: count,
      chunkId: chunkId,
      timestamp: new Date().toISOString(),
      dataSize: dataSize,
      data: randomData
    };

    const chunkJson = JSON.stringify(chunk);
    const chunkBytes = Buffer.byteLength(chunkJson);

    chunks.push({
      number: count,
      size: chunkBytes,
      dataItems: dataSize
    });

    console.log(`[Variable Chunks] Sending chunk ${count}/${maxCount} - ${dataSize} items (${chunkBytes} bytes)`);

    // Write the chunk with a delimiter
    res.write(chunkJson);
    res.write('\n'); // Newline delimiter between chunks

    if (count < maxCount) {
      // Variable delay - faster for small chunks, slower for large ones
      const delay = Math.min(500 + (count * 200), 3000);
      setTimeout(sendChunk, delay);
    } else {
      // Send final summary
      const summary = {
        complete: true,
        totalChunks: maxCount,
        chunks: chunks,
        message: 'All chunks sent using chunked transfer encoding'
      };
      res.write(JSON.stringify(summary));
      res.end();
      console.log('[Variable Chunks] All chunks sent, connection closed');
    }
  };

  // Start sending chunks
  sendChunk();

  // Cleanup on client disconnect
  req.on('close', () => {
    console.log('[Variable Chunks] Client disconnected');
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    endpoints: {
      sse_retry_demo: true,
      migrated_go_endpoints: true
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🚀 Combined Express Server Running!`);
  console.log(`========================================`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`\nSSE Retry Demo:`);
  console.log(`  - http://localhost:${PORT}/index.html`);
  console.log(`\nMigrated Endpoints Demo:`);
  console.log(`  - http://localhost:${PORT}/index-migrated-endpoints.html`);
  console.log(`\nAPI Endpoints:`);
  console.log(`  - GET  /api/hello`);
  console.log(`  - GET  /api/slow`);
  console.log(`  - GET  /api/close-delimited`);
  console.log(`  - GET  /api/variable-chunks`);
  console.log(`\nSSE Endpoints:`);
  console.log(`  - GET  /sse/single`);
  console.log(`  - GET  /sse/single-no-chunked`);
  console.log(`  - GET  /sse/multiple`);
  console.log(`  - GET  /sse/compressed`);
  console.log(`  - GET  /sse/multiple-no-chunked`);
  console.log(`\nSSE Retry Endpoints:`);
  console.log(`  - GET  /events`);
  console.log(`  - GET  /events-content-length`);
  console.log(`  - GET  /events-connection-close-server`);
  console.log(`  - GET  /events-no-headers`);
  console.log(`  - GET  /events-send-and-close`);
  console.log(`\nUtility:`);
  console.log(`  - GET  /health`);
  console.log(`  - POST /control/close/:connectionId/:mode`);
  console.log(`  - GET  /control/connections`);
  console.log(`========================================\n`);
});
