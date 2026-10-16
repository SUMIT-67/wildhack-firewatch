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
const NODE_TIMEOUT_SECONDS = parseInt(process.env.NODE_TIMEOUT_SECONDS, 10) || 90;
const NODE_TIMEOUT_MS = NODE_TIMEOUT_SECONDS * 1000;
const WATCHDOG_INTERVAL_MS = 15000;
const SERVER_STARTUP_TIME = Date.now();
const STARTUP_GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes grace period for host restarts
const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes reminder interval for offline sensors

// Known registered Tadoba sensor nodes
const KNOWN_NODES = {
  'NODE-A': { name: 'Moharli Core Buffer', lat: 20.2215, lng: 79.3320 },
  'NODE-B': { name: 'Kolsa Southern Range', lat: 20.1980, lng: 79.4120 },
  'NODE-C': { name: 'Moharli village edge', lat: 20.2680, lng: 79.3250 },
  'NODE-D': { name: 'Kolara Northern Gate', lat: 20.3340, lng: 79.3680 }
};

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
    name TEXT,
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
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN name TEXT;`);
} catch (e) {}

// Seed / Update known node names in database
const seedNodeStmt = db.prepare(`
  INSERT OR IGNORE INTO nodes (nodeId, name, lat, lng, temp, humidity, smoke, flame, status, score, lastSeen)
  VALUES (@nodeId, @name, @lat, @lng, 28.0, 50.0, 7.0, 0, 'NORMAL', 0, 0)
`);
const updateNodeNameStmt = db.prepare(`
  UPDATE nodes SET name = ? WHERE nodeId = ? AND (name IS NULL OR name = '' OR name != ?)
`);
for (const [nodeId, meta] of Object.entries(KNOWN_NODES)) {
  seedNodeStmt.run({
    nodeId,
    name: meta.name,
    lat: meta.lat,
    lng: meta.lng
  });
  updateNodeNameStmt.run(meta.name, nodeId, meta.name);
}

// Prepared statements for high performance
const insertReadingStmt = db.prepare(`
  INSERT INTO readings (nodeId, lat, lng, temp, humidity, smoke, flame, status, score, createdAt)
  VALUES (@nodeId, @lat, @lng, @temp, @humidity, @smoke, @flame, @status, @score, @createdAt)
`);

const upsertNodeStmt = db.prepare(`
  INSERT INTO nodes (nodeId, name, lat, lng, temp, humidity, smoke, flame, status, score, lastSeen)
  VALUES (@nodeId, @name, @lat, @lng, @temp, @humidity, @smoke, @flame, @status, @score, @lastSeen)
  ON CONFLICT(nodeId) DO UPDATE SET
    name = COALESCE(excluded.name, nodes.name),
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

// Time formatting helpers (Asia/Kolkata)
function formatKolkataTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatKolkataDateTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// Telegram messaging helper with complete result logging and token protection
async function sendTelegramMessage(text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] Skipping dispatch: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured');
    return null;
  }

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: false,
    ...options
  };

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const resJson = await res.json().catch(() => null);
    if (res.ok && resJson && resJson.ok) {
      console.log(`[Telegram] Dispatch success (msg_id: ${resJson.result?.message_id})`);
    } else {
      const desc = resJson?.description || `HTTP ${res.status}`;
      console.warn(`[Telegram] Dispatch failed: ${desc}`);
    }
    return resJson;
  } catch (err) {
    const safeError = TELEGRAM_BOT_TOKEN
      ? err.message.replace(new RegExp(TELEGRAM_BOT_TOKEN, 'g'), '[REDACTED]')
      : err.message;
    console.error(`[Telegram] Network error: ${safeError}`);
    return null;
  }
}

// Telegram fire & risk warning notification helper
async function sendTelegramAlert(alertData, nearestResponder) {
  const emoji = alertData.status === 'FIRE' ? '🚨🚨 *CRITICAL WILDFIRE DETECTED*' : '⚠️ *WILDFIRE RISK WARNING*';
  const gmapsUrl = `https://maps.google.com/?q=${alertData.lat},${alertData.lng}`;
  const actionText = alertData.status === 'FIRE'
    ? 'Dispatch nearest team, notify DFO, start containment'
    : 'Verify via patrol / drone, monitor trend';

  const satText = alertData.satelliteConfirmed
    ? `Satellite: confirmed, ${alertData.distance} km away`
    : `Satellite: no hotspot yet`;

  const kolkataTimeStr = formatKolkataDateTime(alertData.time);

  const text = `${emoji}
*Reserve:* Tadoba Andhari Tiger Reserve (TATR)
*Node ID:* ${alertData.nodeId}
*Status:* ${alertData.status}
*Time:* ${kolkataTimeStr} IST

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

  await sendTelegramMessage(text, { parse_mode: 'Markdown' });
}

// Outage State Tracker for Watchdog
const nodeOutageTracker = new Map();

function getOrCreateOutage(nodeId) {
  let outage = nodeOutageTracker.get(nodeId);
  if (!outage) {
    outage = {
      isOffline: false,
      offlineSince: 0,
      lastAlertSentTime: 0,
      alertRecordId: null
    };
    nodeOutageTracker.set(nodeId, outage);
  }
  return outage;
}

// Send offline alert via Telegram (plain text, requirement 2 & 5)
async function sendOfflineTelegramMessage(node, outage, now) {
  const nodeName = node.name || KNOWN_NODES[node.nodeId]?.name;
  const nodeLabel = nodeName ? `${node.nodeId} (${nodeName})` : node.nodeId;
  const gmapsUrl = `https://maps.google.com/?q=${node.lat},${node.lng}`;
  const hasReported = typeof node.lastSeen === 'number' && node.lastSeen > 0;

  let text;
  if (hasReported) {
    const timeStr = formatKolkataTime(node.lastSeen);
    const tempStr = Math.round(node.temp) + 'C';
    const humStr = Math.round(node.humidity) + '%';
    const smokeStr = 'smoke ' + Math.round(node.smoke) + '%';

    text = `SENSOR OFFLINE: ${nodeLabel}. No data since ${timeStr} IST.\nLast reading: ${tempStr}, ${humStr}, ${smokeStr}. Location: ${gmapsUrl}\nPlease inspect the sensor.`;
  } else {
    text = `SENSOR OFFLINE: ${nodeLabel}. Never reported data. Location: ${gmapsUrl}\nPlease inspect the sensor.`;
  }

  await sendTelegramMessage(text);
  outage.lastAlertSentTime = now;
}

// Watchdog: runs every 15s to check sensor node health
async function checkNodesHealth() {
  const now = Date.now();
  const inGracePeriod = (now - SERVER_STARTUP_TIME) < STARTUP_GRACE_PERIOD_MS;
  const nodes = getAllNodesStmt.all();

  for (const node of nodes) {
    const outage = getOrCreateOutage(node.nodeId);
    const hasReported = typeof node.lastSeen === 'number' && node.lastSeen > 0;
    const isTimedOut = hasReported
      ? (now - node.lastSeen) > NODE_TIMEOUT_MS
      : !inGracePeriod; // Never reported nodes treated as offline after grace period

    if (isTimedOut) {
      if (!outage.isOffline) {
        // Node has just transitioned to OFFLINE
        outage.isOffline = true;
        outage.offlineSince = hasReported ? node.lastSeen : now;

        // Mark node OFFLINE in database
        db.prepare(`UPDATE nodes SET status = 'OFFLINE' WHERE nodeId = ?`).run(node.nodeId);

        // Broadcast node status change over SSE
        broadcastSSE('node_status', {
          nodeId: node.nodeId,
          status: 'OFFLINE',
          lastSeen: node.lastSeen
        });

        // 1. Create ONE alert of type "SENSOR_FAULT"
        const existingFaultAlert = db.prepare(`
          SELECT id FROM alerts
          WHERE nodeId = ? AND status = 'SENSOR_FAULT' AND acknowledged = 0 AND (message LIKE '%OFFLINE%' OR message LIKE '%no data%')
          ORDER BY id DESC LIMIT 1
        `).get(node.nodeId);

        if (!existingFaultAlert) {
          const timeIso = new Date(now).toISOString();
          const nodeName = node.name || KNOWN_NODES[node.nodeId]?.name;
          const nodeLabel = nodeName ? `${node.nodeId} (${nodeName})` : node.nodeId;
          const nearestResponder = getNearestResponder(node.lat, node.lng);
          const faultMessage = hasReported
            ? `SENSOR OFFLINE: ${nodeLabel} has sent no data for ${NODE_TIMEOUT_SECONDS}s.`
            : `SENSOR OFFLINE: ${nodeLabel} never reported data.`;

          const alertResult = insertAlertStmt.run({
            nodeId: node.nodeId,
            status: 'SENSOR_FAULT',
            lat: node.lat,
            lng: node.lng,
            message: faultMessage,
            time: timeIso,
            satelliteConfirmed: 0,
            distance: null
          });

          outage.alertRecordId = alertResult.lastInsertRowid;

          broadcastSSE('alert', {
            id: alertResult.lastInsertRowid,
            nodeId: node.nodeId,
            status: 'SENSOR_FAULT',
            lat: node.lat,
            lng: node.lng,
            message: faultMessage,
            time: timeIso,
            acknowledged: 0,
            satelliteConfirmed: false,
            distance: null,
            nearestResponder,
            suggestedAction: 'Inspect sensor hardware, battery, and radio connectivity in field',
            temp: node.temp,
            humidity: node.humidity,
            smoke: node.smoke,
            flame: Boolean(node.flame),
            score: 0
          });
        }

        // 2. Telegram message (Requirement 2 & 5)
        if (!inGracePeriod) {
          await sendOfflineTelegramMessage(node, outage, now);
        }
      } else {
        // Node was already offline: Check for 30-min reminder (Requirement 3)
        if (!inGracePeriod) {
          if (!outage.lastAlertSentTime) {
            // Grace period expired while node was already offline
            await sendOfflineTelegramMessage(node, outage, now);
          } else if (now - outage.lastAlertSentTime >= REMINDER_INTERVAL_MS) {
            // 30 minute reminder
            await sendOfflineTelegramMessage(node, outage, now);
          }
        }
      }
    }
  }
}

// Start Watchdog interval (every 15s)
setInterval(checkNodesHealth, WATCHDOG_INTERVAL_MS);

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

  const { nodeId, lat, lng, temp, humidity, smoke, flame, name } = req.body;

  // Basic nodeId check
  if (!nodeId || typeof nodeId !== 'string') {
    return res.status(400).json({ error: 'nodeId is required and must be a string' });
  }

  const now = Date.now();
  const timeIso = new Date(now).toISOString();
  const existingNode = getNodeStmt.get(nodeId);

  // 6. Reading-level faults check
  const isMissingOrNaN =
    lat == null || lng == null || temp == null || humidity == null || smoke == null ||
    typeof lat !== 'number' || typeof lng !== 'number' ||
    typeof temp !== 'number' || typeof humidity !== 'number' || typeof smoke !== 'number' ||
    isNaN(lat) || isNaN(lng) || isNaN(temp) || isNaN(humidity) || isNaN(smoke);

  const isOutOfRange = !isMissingOrNaN && (
    temp < -10 || temp > 80 ||
    humidity < 0 || humidity > 100 ||
    smoke < 0 || smoke > 100
  );

  let isIdentical20 = false;
  if (!isMissingOrNaN && !isOutOfRange) {
    const prev19 = db.prepare(`
      SELECT temp, humidity, smoke FROM readings
      WHERE nodeId = ?
      ORDER BY id DESC LIMIT 19
    `).all(nodeId);

    if (prev19.length === 19 && prev19.every(r => r.temp === temp && r.humidity === humidity && r.smoke === smoke)) {
      isIdentical20 = true;
    }
  }

  if (isMissingOrNaN || isOutOfRange || isIdentical20) {
    let faultReason = 'telemetry data error';
    if (isMissingOrNaN) faultReason = 'missing or NaN telemetry fields';
    else if (temp < -10 || temp > 80) faultReason = `temp ${temp} outside valid range (-10..80)`;
    else if (humidity < 0 || humidity > 100) faultReason = `humidity ${humidity} outside valid range (0..100)`;
    else if (smoke < 0 || smoke > 100) faultReason = `smoke ${smoke} outside valid range (0..100)`;
    else if (isIdentical20) faultReason = 'identical values for 20 readings in a row';

    const validLat = (typeof lat === 'number' && !isNaN(lat)) ? lat : (existingNode?.lat || KNOWN_NODES[nodeId]?.lat || 0);
    const validLng = (typeof lng === 'number' && !isNaN(lng)) ? lng : (existingNode?.lng || KNOWN_NODES[nodeId]?.lng || 0);
    const nearestResponder = getNearestResponder(validLat, validLng);

    // Create ONE SENSOR_FAULT alert ("possible sensor malfunction")
    const faultMsg = `SENSOR_FAULT: possible sensor malfunction on ${nodeId} (${faultReason})`;
    const recentMalfunctionAlert = db.prepare(`
      SELECT id FROM alerts
      WHERE nodeId = ? AND status = 'SENSOR_FAULT' AND message LIKE '%possible sensor malfunction%' AND acknowledged = 0
      ORDER BY id DESC LIMIT 1
    `).get(nodeId);

    if (!recentMalfunctionAlert) {
      const alertResult = insertAlertStmt.run({
        nodeId,
        status: 'SENSOR_FAULT',
        lat: validLat,
        lng: validLng,
        message: faultMsg,
        time: timeIso,
        satelliteConfirmed: 0,
        distance: null
      });

      broadcastSSE('alert', {
        id: alertResult.lastInsertRowid,
        nodeId,
        status: 'SENSOR_FAULT',
        lat: validLat,
        lng: validLng,
        message: faultMsg,
        time: timeIso,
        acknowledged: 0,
        satelliteConfirmed: false,
        distance: null,
        nearestResponder,
        suggestedAction: 'Inspect and recalibrate sensor hardware in field',
        temp: typeof temp === 'number' && !isNaN(temp) ? temp : null,
        humidity: typeof humidity === 'number' && !isNaN(humidity) ? humidity : null,
        smoke: typeof smoke === 'number' && !isNaN(smoke) ? smoke : null,
        flame: Boolean(flame),
        score: 0
      });
    }

    // Update lastSeen so node is known to be transmitting, but do not use reading for fire logic
    if (existingNode) {
      db.prepare(`UPDATE nodes SET lastSeen = ? WHERE nodeId = ?`).run(now, nodeId);
    }

    return res.status(200).json({
      status: 'SENSOR_FAULT',
      score: 0,
      alert: 'possible sensor malfunction',
      reason: faultReason
    });
  }

  // Node is communicating valid reading: check if recovering from outage
  const outage = getOrCreateOutage(nodeId);
  if (outage.isOffline) {
    const outageMs = now - outage.offlineSince;
    const outageMin = Math.max(1, Math.round(outageMs / 60000));

    // Requirement 4: "SENSOR RECOVERED: NODE-C is back online after 12 min"
    const recoveryText = `SENSOR RECOVERED: ${nodeId} is back online after ${outageMin} min`;
    sendTelegramMessage(recoveryText);

    // Clear fault alert
    db.prepare(`
      DELETE FROM alerts
      WHERE nodeId = ? AND status = 'SENSOR_FAULT' AND (message LIKE '%OFFLINE%' OR message LIKE '%no data%')
    `).run(nodeId);

    broadcastSSE('alert_clear', { nodeId, status: 'SENSOR_FAULT' });

    // Reset outage tracking
    outage.isOffline = false;
    outage.offlineSince = 0;
    outage.lastAlertSentTime = 0;
    outage.alertRecordId = null;
  }

  const parsedFlame = Boolean(flame);

  // Compute status and risk score
  const { status, score } = computeStatusAndScore(temp, humidity, smoke, parsedFlame);

  // Check previous status for alert transition
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
  const nodeName = name || (existingNode && existingNode.name) || KNOWN_NODES[nodeId]?.name || null;
  upsertNodeStmt.run({
    nodeId,
    name: nodeName,
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
    name: nodeName,
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

// Get latest state of all nodes (marking nodes offline if no data for NODE_TIMEOUT_SECONDS)
app.get('/api/nodes', (req, res) => {
  const nodes = getAllNodesStmt.all();
  const now = Date.now();

  const enrichedNodes = nodes.map(node => {
    const isOffline = !node.lastSeen || (now - node.lastSeen) > NODE_TIMEOUT_MS;
    const effectiveStatus = isOffline ? 'OFFLINE' : node.status;
    const nearest = getNearestResponder(node.lat, node.lng);

    return {
      ...node,
      name: node.name || KNOWN_NODES[node.nodeId]?.name || null,
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
