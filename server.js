const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'wildhack-secret';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new Database(path.join(__dirname, 'firewatch.db'));
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeId TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    temp REAL NOT NULL,
    humidity REAL NOT NULL,
    smoke REAL NOT NULL,
    flame INTEGER NOT NULL,
    status TEXT NOT NULL,
    score REAL NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nodes (
    nodeId TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    temp REAL NOT NULL,
    humidity REAL NOT NULL,
    smoke REAL NOT NULL,
    flame INTEGER NOT NULL,
    status TEXT NOT NULL,
    score REAL NOT NULL,
    lastSeen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeId TEXT NOT NULL,
    status TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    message TEXT NOT NULL,
    time TEXT NOT NULL,
    acknowledged INTEGER DEFAULT 0,
    acknowledgedAt TEXT,
    satelliteConfirmed INTEGER DEFAULT 0,
    distance REAL
  );

  CREATE INDEX IF NOT EXISTS idx_readings_node_time ON readings(nodeId, id DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(id DESC);
`);

// Migrate schema if columns are missing
try {
  db.exec(`ALTER TABLE alerts ADD COLUMN satelliteConfirmed INTEGER DEFAULT 0;`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE alerts ADD COLUMN distance REAL;`);
} catch (e) {}

// Prepared statements for high performance
const insertReadingStmt = db.prepare(`
  INSERT INTO readings (nodeId, lat, lng, temp, humidity, smoke, flame, status, score, createdAt)
  VALUES (@nodeId, @lat, @lng, @temp, @humidity, @smoke, @flame, @status, @score, @createdAt)
`);

const upsertNodeStmt = db.prepare(`
  INSERT INTO nodes (nodeId, lat, lng, temp, humidity, smoke, flame, status, score, lastSeen)
  VALUES (@nodeId, @lat, @lng, @temp, @humidity, @smoke, @flame, @status, @score, @lastSeen)
  ON CONFLICT(nodeId) DO UPDATE SET
    lat = excluded.lat,
    lng = excluded.lng,
    temp = excluded.temp,
    humidity = excluded.humidity,
    smoke = excluded.smoke,
    flame = excluded.flame,
    status = excluded.status,
    score = excluded.score,
    lastSeen = excluded.lastSeen
`);

const getNodeStmt = db.prepare(`SELECT * FROM nodes WHERE nodeId = ?`);
const getAllNodesStmt = db.prepare(`SELECT * FROM nodes ORDER BY nodeId ASC`);

const insertAlertStmt = db.prepare(`
  INSERT INTO alerts (nodeId, status, lat, lng, message, time, acknowledged, satelliteConfirmed, distance)
  VALUES (@nodeId, @status, @lat, @lng, @message, @time, 0, @satelliteConfirmed, @distance)
`);

const getAlertsStmt = db.prepare(`
  SELECT * FROM alerts ORDER BY id DESC LIMIT 50
`);

const getHistoryStmt = db.prepare(`
  SELECT * FROM (
    SELECT id, nodeId, temp, humidity, smoke, flame, status, score, createdAt
    FROM readings
    WHERE nodeId = ?
    ORDER BY id DESC
    LIMIT 60
  ) ORDER BY id ASC
`);

const ackAlertStmt = db.prepare(`
  UPDATE alerts SET acknowledged = 1, acknowledgedAt = ? WHERE id = ?
`);

// NASA FIRMS Satellite Verification State & Helpers
let cachedHotspots = [];
let lastHotspotFetchTime = 0;
const HOTSPOT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
let hotspotFetchPromise = null;

function parseFirmsCsv(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];
  const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
  const latIdx = headers.indexOf('latitude');
  const lonIdx = headers.indexOf('longitude');
  const dateIdx = headers.indexOf('acq_date');
  const timeIdx = headers.indexOf('acq_time');
  const confIdx = headers.indexOf('confidence');
  const frpIdx = headers.indexOf('frp');

  if (latIdx === -1 || lonIdx === -1) {
    return [];
  }

  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (row.length <= Math.max(latIdx, lonIdx)) continue;

    const lat = parseFloat(row[latIdx]);
    const lon = parseFloat(row[lonIdx]);
    if (isNaN(lat) || isNaN(lon)) continue;

    const acq_date = dateIdx !== -1 ? row[dateIdx] : '';
    const acq_time = timeIdx !== -1 ? row[timeIdx] : '';
    const confidence = confIdx !== -1 ? row[confIdx] : '';
    const frp = frpIdx !== -1 ? (parseFloat(row[frpIdx]) || 0) : 0;

    results.push({
      latitude: lat,
      longitude: lon,
      acq_date,
      acq_time,
      confidence,
      frp
    });
  }
  return results;
}

async function fetchHotspots() {
  if (!FIRMS_MAP_KEY) {
    return cachedHotspots;
  }

  if (Date.now() - lastHotspotFetchTime < HOTSPOT_CACHE_TTL) {
    return cachedHotspots;
  }

  if (hotspotFetchPromise) {
    return hotspotFetchPromise;
  }

  hotspotFetchPromise = (async () => {
    try {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/79.0,20.0,79.7,20.6/2`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`NASA FIRMS API returned status ${res.status}`);
      }
      const csvText = await res.text();
      if (csvText.startsWith('Invalid') || csvText.startsWith('Error')) {
        throw new Error(`NASA FIRMS API error: ${csvText.trim()}`);
      }
      const hotspots = parseFirmsCsv(csvText);
      cachedHotspots = hotspots;
      lastHotspotFetchTime = Date.now();
      return cachedHotspots;
    } catch (err) {
      console.error('NASA FIRMS fetch error:', err.message);
      return cachedHotspots;
    } finally {
      hotspotFetchPromise = null;
    }
  })();

  return hotspotFetchPromise;
}

// 4 Demo Ranger / Watchtower locations in Tadoba Andhari Tiger Reserve
const RESPONDERS = [
  {
    id: 'RESP-MOHARLI',
    name: 'Moharli Forest Station & Watchtower',
    type: 'Watchtower / Range Office',
    lat: 20.1872,
    lng: 79.3142,
    contact: '+91 7172 251 201'
  },
  {
    id: 'RESP-KOLARA',
    name: 'Kolara Quick Response Camp',
    type: 'Rapid Action Patrol',
    lat: 20.3621,
    lng: 79.3875,
    contact: '+91 7172 251 202'
  },
  {
    id: 'RESP-NAVEGAON',
    name: 'Navegaon Range Outpost',
    type: 'Buffer Patrol Unit',
    lat: 20.3210,
    lng: 79.4310,
    contact: '+91 7172 251 203'
  },
  {
    id: 'RESP-TADOBA-HQ',
    name: 'Tadoba Lake Watchtower HQ',
    type: 'Central Reserve Watchtower',
    lat: 20.2450,
    lng: 79.3490,
    contact: '+91 7172 251 204'
  }
];

// Haversine distance helper
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function getNearestResponder(lat, lng) {
  let nearest = null;
  let minDistance = Infinity;
  for (const r of RESPONDERS) {
    const dist = haversineDistanceKm(lat, lng, r.lat, r.lng);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = { ...r, distanceKm: dist };
    }
  }
  return nearest;
}

// Risk calculation & status evaluation
function computeStatusAndScore(temp, humidity, smoke, flame) {
  const isFlame = Boolean(flame);
  const isDirectFire = isFlame || (smoke > 60 && temp > 50);

  let score = 0;
  // Temperature scoring
  if (temp > 45) {
    score += 30;
  } else if (temp > 38) {
    score += 15;
  }

  // Humidity scoring
  if (humidity < 30) {
    score += 20;
  } else if (humidity < 40) {
    score += 10;
  }

  // Smoke scoring
  if (smoke > 40) {
    score += 30;
  } else if (smoke > 25) {
    score += 15;
  }

  if (isDirectFire) {
    return {
      status: 'FIRE',
      score: Math.max(score, 90)
    };
  }

  if (score >= 40) {
    return {
      status: 'WARNING',
      score
    };
  }

  return {
    status: 'NORMAL',
    score
  };
}

// Telegram notification helper
async function sendTelegramAlert(alertData, nearestResponder) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const emoji = alertData.status === 'FIRE' ? '🚨🚨 *CRITICAL WILDFIRE DETECTED*' : '⚠️ *WILDFIRE RISK WARNING*';
  const gmapsUrl = `https://maps.google.com/?q=${alertData.lat},${alertData.lng}`;
  const actionText = alertData.status === 'FIRE'
    ? 'Dispatch nearest team, notify DFO, start containment'
    : 'Verify via patrol / drone, monitor trend';

  const satText = alertData.satelliteConfirmed
    ? `Satellite: confirmed, ${alertData.distance} km away`
    : `Satellite: no hotspot yet`;

  const text = `${emoji}
*Reserve:* Tadoba Andhari Tiger Reserve (TATR)
*Node ID:* ${alertData.nodeId}
*Status:* ${alertData.status}
*Time:* ${alertData.time}

*Telemetry Data:*
• Temp: ${alertData.temp}°C
• Humidity: ${alertData.humidity}%
• Smoke Level: ${alertData.smoke}%
• Flame Detected: ${alertData.flame ? 'YES 🔥' : 'NO'}
• Risk Score: ${alertData.score}/100
• ${satText}

*Nearest Responder:*
• ${nearestResponder.name} (${nearestResponder.distanceKm} km away)
• Contact: ${nearestResponder.contact}

*Suggested Action:*
${actionText}

*GPS Location:* [Open in Google Maps](${gmapsUrl})`;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      })
    });
  } catch (err) {
    console.error('Telegram dispatch error:', err.message);
  }
}

// Server-Sent Events (SSE) Client Manager
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// SSE Keep-alive heartbeat (every 25 seconds)
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 25000);

// ==================== ROUTES ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Responders list
app.get('/api/responders', (req, res) => {
  res.json(RESPONDERS);
});

// SSE Stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sseClients.add(res);

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Ingest Sensor Readings
app.post('/api/readings', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing x-api-key' });
  }

  const { nodeId, lat, lng, temp, humidity, smoke, flame } = req.body;

  // Validation
  if (!nodeId || typeof nodeId !== 'string') {
    return res.status(400).json({ error: 'nodeId is required and must be a string' });
  }
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers' });
  }
  if (typeof temp !== 'number' || typeof humidity !== 'number' || typeof smoke !== 'number') {
    return res.status(400).json({ error: 'temp, humidity, and smoke must be numbers' });
  }

  const parsedFlame = Boolean(flame);
  const now = Date.now();
  const timeIso = new Date(now).toISOString();

  // Compute status and risk score
  const { status, score } = computeStatusAndScore(temp, humidity, smoke, parsedFlame);

  // Check previous status for alert transition
  const existingNode = getNodeStmt.get(nodeId);
  const prevStatus = existingNode ? existingNode.status : null;

  // Nearest responder
  const nearestResponder = getNearestResponder(lat, lng);

  // Store reading
  insertReadingStmt.run({
    nodeId,
    lat,
    lng,
    temp,
    humidity,
    smoke,
    flame: parsedFlame ? 1 : 0,
    status,
    score,
    createdAt: timeIso
  });

  // Upsert node latest state
  upsertNodeStmt.run({
    nodeId,
    lat,
    lng,
    temp,
    humidity,
    smoke,
    flame: parsedFlame ? 1 : 0,
    status,
    score,
    lastSeen: now
  });

  // Check if status changed to FIRE or WARNING
  let alertRecord = null;
  const statusChangedToAlert = prevStatus !== status && (status === 'FIRE' || status === 'WARNING');

  if (statusChangedToAlert) {
    let satelliteConfirmed = false;
    let distance = null;

    if (status === 'FIRE' && FIRMS_MAP_KEY) {
      const hotspots = await fetchHotspots();
      let minDistance = Infinity;
      for (const hs of hotspots) {
        const d = haversineDistanceKm(lat, lng, hs.latitude, hs.longitude);
        if (d <= 5.0 && d < minDistance) {
          minDistance = d;
        }
      }
      if (minDistance !== Infinity) {
        satelliteConfirmed = true;
        distance = minDistance;
      }
    }

    const actionText = status === 'FIRE'
      ? 'Dispatch nearest team, notify DFO, start containment'
      : 'Verify via patrol / drone, monitor trend';

    const message = status === 'FIRE'
      ? `CRITICAL: Active fire detected at ${nodeId}! Flame/Smoke spike observed.`
      : `WARNING: High fire risk at ${nodeId} (Score: ${score}/100). Extreme dry/hot conditions.`;

    const alertResult = insertAlertStmt.run({
      nodeId,
      status,
      lat,
      lng,
      message,
      time: timeIso,
      satelliteConfirmed: satelliteConfirmed ? 1 : 0,
      distance
    });

    alertRecord = {
      id: alertResult.lastInsertRowid,
      nodeId,
      status,
      lat,
      lng,
      message,
      time: timeIso,
      acknowledged: 0,
      satelliteConfirmed,
      distance,
      nearestResponder,
      suggestedAction: actionText,
      temp,
      humidity,
      smoke,
      flame: parsedFlame,
      score
    };

    // Broadcast alert event over SSE
    broadcastSSE('alert', alertRecord);

    // Send Telegram alert (asynchronous, non-blocking)
    sendTelegramAlert(alertRecord, nearestResponder);
  }

  // Broadcast every reading over SSE for live updates
  broadcastSSE('reading', {
    nodeId,
    lat,
    lng,
    temp,
    humidity,
    smoke,
    flame: parsedFlame,
    status,
    score,
    lastSeen: now,
    nearestResponder
  });

  return res.status(200).json({ status, score });
});

// Get latest state of all nodes (marking nodes offline if no data for 60s)
app.get('/api/nodes', (req, res) => {
  const nodes = getAllNodesStmt.all();
  const now = Date.now();

  const enrichedNodes = nodes.map(node => {
    const isOffline = (now - node.lastSeen) > 60000;
    const effectiveStatus = isOffline ? 'OFFLINE' : node.status;
    const nearest = getNearestResponder(node.lat, node.lng);

    return {
      ...node,
      flame: Boolean(node.flame),
      status: effectiveStatus,
      rawStatus: node.status,
      isOffline,
      nearestResponder: nearest
    };
  });

  res.json(enrichedNodes);
});

// Get NASA FIRMS cached hotspots as JSON
app.get('/api/hotspots', async (req, res) => {
  try {
    const hotspots = await fetchHotspots();
    res.json(hotspots);
  } catch (err) {
    res.json(cachedHotspots);
  }
});

// Get last 50 alerts, newest first
app.get('/api/alerts', (req, res) => {
  const alerts = getAlertsStmt.all();
  const enrichedAlerts = alerts.map(alert => {
    const nearest = getNearestResponder(alert.lat, alert.lng);
    const suggestedAction = alert.status === 'FIRE'
      ? 'Dispatch nearest team, notify DFO, start containment'
      : 'Verify via patrol / drone, monitor trend';

    return {
      ...alert,
      acknowledged: Boolean(alert.acknowledged),
      satelliteConfirmed: Boolean(alert.satelliteConfirmed),
      distance: alert.distance != null ? alert.distance : null,
      nearestResponder: nearest,
      suggestedAction
    };
  });

  res.json(enrichedAlerts);
});

// Get history readings for mini charts
app.get('/api/history/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const history = getHistoryStmt.all(nodeId);
  res.json(history);
});

// Acknowledge alert
app.post('/api/alerts/:id/ack', (req, res) => {
  const alertId = parseInt(req.params.id, 10);
  if (isNaN(alertId)) {
    return res.status(400).json({ error: 'Invalid alert ID' });
  }

  const acknowledgedAt = new Date().toISOString();
  const result = ackAlertStmt.run(acknowledgedAt, alertId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Alert not found' });
  }

  // Broadcast acknowledgment to sync all connected dashboards
  broadcastSSE('alert_ack', { id: alertId, acknowledgedAt });

  res.json({ ok: true, id: alertId, acknowledgedAt });
});

// Fallback route for static SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🌲 WildHack FireWatch Server Running`);
  console.log(`📍 Location: Tadoba Andhari Tiger Reserve (TATR)`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
  console.log(`📡 SSE Stream: http://localhost:${PORT}/api/stream`);
  if (FIRMS_MAP_KEY) {
    console.log(`🛰️ NASA FIRMS: Active verification enabled`);
    fetchHotspots().catch(() => {});
  }
  console.log(`=======================================================`);
});
