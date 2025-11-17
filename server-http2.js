const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = 3001;

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
  const eventId = crypto.randomBytes(8).toString('hex');
  const randomMsg = messages[Math.floor(Math.random() * messages.length)];
  globalEventCounter++;

  const data = {
    message: `${randomMsg.emoji} ${randomMsg.text}`,
    timestamp: new Date().toISOString(),
    eventNumber: globalEventCounter
  };

  eventHistory.push({ id: eventId, data });
  console.log(`Generated event #${globalEventCounter} [ID: ${eventId}]: ${randomMsg.text}`);

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

// Helper function to get MIME type
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// Helper function to serve static files
function serveStaticFile(stream, headers, filePath) {
  const fullPath = path.join(__dirname, filePath);

  fs.stat(fullPath, (err, stat) => {
    if (err) {
      if (err.code === 'ENOENT') {
        stream.respond({
          ':status': 404,
          'content-type': 'text/plain'
        });
        stream.end('Not Found');
      } else {
        stream.respond({
          ':status': 500,
          'content-type': 'text/plain'
        });
        stream.end('Internal Server Error');
      }
      return;
    }

    stream.respond({
      ':status': 200,
      'content-type': getMimeType(filePath),
      'content-length': stat.size
    });

    const fileStream = fs.createReadStream(fullPath);
    fileStream.pipe(stream);
  });
}

// Helper function to respond with JSON
function respondJSON(stream, data, status = 200) {
  const json = JSON.stringify(data, null, 2);
  stream.respond({
    ':status': status,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json)
  });
  stream.end(json);
}

// Create HTTP/2 server
const server = http2.createSecureServer({
  key: fs.readFileSync(path.join(__dirname, 'server.key')),
  cert: fs.readFileSync(path.join(__dirname, 'server.cert'))
});

server.on('error', (err) => console.error('Server error:', err));

server.on('stream', (stream, headers) => {
  const method = headers[':method'];
  const url = new URL(headers[':path'], `https://localhost:${PORT}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  console.log(`${method} ${pathname}`);

  // ====================================
  // Static File Serving
  // ====================================

  if (method === 'GET' && pathname === '/') {
    serveStaticFile(stream, headers, 'index.html');
    return;
  }

  if (method === 'GET' && pathname.startsWith('/static/')) {
    serveStaticFile(stream, headers, pathname);
    return;
  }

  if (method === 'GET' && pathname.endsWith('.html')) {
    serveStaticFile(stream, headers, pathname);
    return;
  }

  // ====================================
  // Event Generation Control
  // ====================================

  if (method === 'POST' && pathname === '/start-event-generation') {
    startEventGeneration();
    respondJSON(stream, { message: 'Event generation started' });
    return;
  }

  if (method === 'POST' && pathname === '/stop-event-generation') {
    if (eventGenerationInterval) {
      console.log('🛑 Stopping event generation (manual request)');
      clearInterval(eventGenerationInterval);
      eventGenerationInterval = null;
    }
    stream.respond({ ':status': 204 });
    stream.end();
    return;
  }

  // ====================================
  // Connection Control
  // ====================================

  if (method === 'POST' && pathname.startsWith('/control/close/')) {
    const parts = pathname.split('/');
    const connectionId = parts[3];
    const mode = parts[4];
    const connection = activeConnections.get(connectionId);

    if (connection) {
      console.log(`Closing connection ${connectionId} with mode: ${mode}`);

      if (mode === 'no-retry') {
        try {
          connection.stream.write(`event: close\ndata: {"reason": "no-retry"}\n\n`);
        } catch (err) {
          console.log('Error writing close event:', err.message);
        }
      }
      connection.stream.end();
      activeConnections.delete(connectionId);
      respondJSON(stream, { message: `Connection ${connectionId} closed with mode: ${mode}` });
    } else {
      respondJSON(stream, { error: 'Connection not found' }, 404);
    }
    return;
  }

  if (method === 'GET' && pathname === '/control/connections') {
    const connections = Array.from(activeConnections.values()).map(c => ({
      id: c.id,
      connectedAt: c.connectedAt
    }));
    respondJSON(stream, connections);
    return;
  }

  // ====================================
  // SSE Endpoints
  // ====================================

  if (method === 'GET' && pathname === '/events') {
    const retryInterval = parseInt(query.retry) || 3000;
    const lastEventId = headers['last-event-id'];
    const connectionId = `conn_${++connectionIdCounter}`;

    stream.respond({
      ':status': 200,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache'
    });

    console.log(`[${connectionId}] Client connected. Retry interval: ${retryInterval}ms${lastEventId ? `, Resuming from ID: ${lastEventId}` : ''}`);

    startEventGeneration();

    activeConnections.set(connectionId, {
      id: connectionId,
      stream,
      connectedAt: new Date().toISOString()
    });

    stream.write(`retry: ${retryInterval}\n\n`);
    stream.write(`event: connection\ndata: ${JSON.stringify({ connectionId })}\n\n`);

    let eventsToSend = [];
    if (lastEventId) {
      const lastEventIndex = eventHistory.findIndex(e => e.id === lastEventId);
      if (lastEventIndex !== -1) {
        eventsToSend = eventHistory.slice(lastEventIndex + 1);
        console.log(`Client reconnecting. Sending ${eventsToSend.length} accumulated events`);
      } else {
        eventsToSend = eventHistory;
        console.log(`Client reconnecting with old ID. Sending all ${eventsToSend.length} events`);
      }
    } else {
      eventsToSend = eventHistory;
      console.log(`New client connected. Sending all ${eventsToSend.length} accumulated events`);
    }

    eventsToSend.forEach(event => {
      stream.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });

    let lastSentEventNumber = eventsToSend.length > 0 ? eventsToSend[eventsToSend.length - 1].data.eventNumber : 0;

    const intervalId = setInterval(() => {
      const newEvents = eventHistory.filter(e => e.data.eventNumber > lastSentEventNumber);
      newEvents.forEach(event => {
        stream.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
        console.log(`Sent event #${event.data.eventNumber} to client`);
        lastSentEventNumber = event.data.eventNumber;
      });
    }, 500);

    stream.on('close', () => {
      console.log(`[${connectionId}] Client disconnected`);
      clearInterval(intervalId);
      activeConnections.delete(connectionId);
    });

    return;
  }

  // ====================================
  // API Endpoints
  // ====================================

  if (method === 'GET' && pathname === '/api/hello') {
    const id = crypto.randomUUID();
    respondJSON(stream, {
      id: id,
      message: 'Hello from HTTP/2!',
      status: 'success',
      data: {
        framework: 'Node.js HTTP/2',
        version: '1.0.0'
      }
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/slow') {
    const id = query.id || 'unknown';
    const requestId = crypto.randomUUID();

    console.log(`[Slow API] Request ${id} started at ${new Date().toISOString()}`);

    setTimeout(() => {
      console.log(`[Slow API] Request ${id} completed at ${new Date().toISOString()}`);
      respondJSON(stream, {
        id: requestId,
        message: `Slow response for request ${id}`,
        status: 'success',
        timestamp: new Date().toISOString()
      });
    }, 2000);
    return;
  }

  if (method === 'GET' && pathname === '/sse/single') {
    const messageId = crypto.randomUUID();

    stream.respond({
      ':status': 200,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*'
    });

    console.log(`[SSE Single] Sending single message with ID: ${messageId}`);

    const data = {
      id: messageId,
      message: 'Single SSE message from HTTP/2',
      timestamp: new Date().toISOString(),
      count: 1
    };

    stream.write(`id: ${messageId}\ndata: ${JSON.stringify(data)}\n\n`);
    stream.end();
    return;
  }

  if (method === 'GET' && pathname === '/sse/multiple') {
    stream.respond({
      ':status': 200,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*'
    });

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

      stream.write(`id: ${messageId}\ndata: ${JSON.stringify(data)}\n\n`);
      console.log(`[SSE Multiple] Sent message ${count}/${maxCount}`);

      if (count < maxCount) {
        setTimeout(sendMessage, 500);
      } else {
        stream.end();
      }
    };

    sendMessage();

    stream.on('close', () => {
      console.log('[SSE Multiple] Client disconnected');
    });
    return;
  }

  if (method === 'GET' && pathname === '/sse/compressed') {
    stream.respond({
      ':status': 200,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*'
    });

    console.log('[SSE Compressed] Client connected, will send 10 compressed messages');

    let count = 0;
    const maxCount = 10;

    const sendMessage = () => {
      count++;
      const messageId = crypto.randomUUID();

      const largePayload = {
        id: messageId,
        message: `Compressed message ${count} of ${maxCount}`,
        timestamp: new Date().toISOString(),
        count: count,
        data: Array(100).fill({
          field1: 'This is repetitive data that compresses well',
          field2: 'More repetitive content here',
          field3: 'Even more repeated information',
          number: count
        })
      };

      const originalJson = JSON.stringify(largePayload);
      const originalSize = Buffer.byteLength(originalJson);
      const compressed = zlib.gzipSync(originalJson);
      const compressedSize = compressed.length;
      const base64Compressed = compressed.toString('base64');

      const eventData = {
        messageId: messageId,
        compressed: true,
        payload: base64Compressed,
        originalSize: originalSize,
        compressedSize: compressedSize,
        compressionRatio: (compressedSize / originalSize * 100).toFixed(2) + '%'
      };

      stream.write(`id: ${messageId}\ndata: ${JSON.stringify(eventData)}\n\n`);
      console.log(`[SSE Compressed] Sent message ${count}/${maxCount} (${originalSize}B -> ${compressedSize}B, ratio: ${eventData.compressionRatio})`);

      if (count < maxCount) {
        setTimeout(sendMessage, 500);
      } else {
        stream.end();
      }
    };

    sendMessage();

    stream.on('close', () => {
      console.log('[SSE Compressed] Client disconnected');
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/variable-chunks') {
    stream.respond({
      ':status': 200,
      'content-type': 'application/json',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*'
    });

    console.log('[Variable Chunks] Client connected, will send variable-sized chunks');

    let count = 0;
    const maxCount = 5;
    const chunks = [];

    const sendChunk = () => {
      count++;
      const chunkId = crypto.randomUUID();
      const sizes = [1, 2, 3, 4, 5];
      const dataSize = sizes[count - 1] || 5;

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

      stream.write(chunkJson);
      stream.write('\n');

      if (count < maxCount) {
        const delay = Math.min(500 + (count * 200), 3000);
        setTimeout(sendChunk, delay);
      } else {
        const summary = {
          complete: true,
          totalChunks: maxCount,
          chunks: chunks,
          message: 'All chunks sent using HTTP/2'
        };
        stream.write(JSON.stringify(summary));
        stream.end();
        console.log('[Variable Chunks] All chunks sent, connection closed');
      }
    };

    sendChunk();

    stream.on('close', () => {
      console.log('[Variable Chunks] Client disconnected');
    });
    return;
  }

  if (method === 'GET' && pathname === '/health') {
    respondJSON(stream, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      protocol: 'HTTP/2',
      endpoints: {
        sse_retry_demo: true,
        migrated_go_endpoints: true
      }
    });
    return;
  }

  // 404 Not Found
  stream.respond({
    ':status': 404,
    'content-type': 'text/plain'
  });
  stream.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🚀 HTTP/2 Server Running!`);
  console.log(`========================================`);
  console.log(`Server: https://localhost:${PORT}`);
  console.log(`\nHTTP/2 HOL Blocking Demo:`);
  console.log(`  - https://localhost:${PORT}/hol-blocking-http2.html`);
  console.log(`\nSSE Retry Demo:`);
  console.log(`  - https://localhost:${PORT}/index.html`);
  console.log(`\nAPI Endpoints:`);
  console.log(`  - GET  /api/hello`);
  console.log(`  - GET  /api/slow`);
  console.log(`  - GET  /api/variable-chunks`);
  console.log(`\nSSE Endpoints:`);
  console.log(`  - GET  /sse/single`);
  console.log(`  - GET  /sse/multiple`);
  console.log(`  - GET  /sse/compressed`);
  console.log(`\nSSE Retry Endpoints:`);
  console.log(`  - GET  /events`);
  console.log(`\nUtility:`);
  console.log(`  - GET  /health`);
  console.log(`  - POST /control/close/:connectionId/:mode`);
  console.log(`  - GET  /control/connections`);
  console.log(`========================================\n`);
});
