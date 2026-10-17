if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (e) {
    // .env file not present or unreadable, continue with system env vars
  }
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'wildhack-secret';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY;
const NODE_TIMEOUT_SECONDS = parseInt(process.env.NODE_TIMEOUT_SECONDS, 10) || 30;
const NODE_TIMEOUT_MS = NODE_TIMEOUT_SECONDS * 1000;
const WATCHDOG_INTERVAL_MS = 15000;
const SERVER_STARTUP_TIME = Date.now();
const STARTUP_GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes grace period for host restarts
const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes reminder interval for offline sensors

// Load registered sensor nodes from nodes.config.json
const NODES_CONFIG_PATH = path.join(__dirname, 'nodes.config.json');
let NODES_CONFIG = [];
try {
  NODES_CONFIG = JSON.parse(fs.readFileSync(NODES_CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`[!] Failed to load ${NODES_CONFIG_PATH}:`, err.message);
  process.exit(1);
}

// Build fast lookup map from configuration
const KNOWN_NODES = {};
for (const conf of NODES_CONFIG) {
  KNOWN_NODES[conf.nodeId || conf.id] = conf;
}

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
try {
  db.exec(`ALTER TABLE readings ADD COLUMN co2 REAL;`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE readings ADD COLUMN windSpeed REAL;`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE readings ADD COLUMN windDir REAL;`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN co2 REAL;`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN windSpeed REAL;`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN windDir REAL;`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE alerts ADD COLUMN spreadEstimate TEXT;`);
} catch (e) {}

// Seed / Update registered nodes in database from nodes.config.json
const seedNodeStmt = db.prepare(`
  INSERT INTO nodes (nodeId, name, lat, lng, temp, humidity, smoke, flame, status, score, lastSeen)
  VALUES (@nodeId, @name, @lat, @lng, 28.0, 50.0, 7.0, 0, 'NORMAL', 0, 0)
  ON CONFLICT(nodeId) DO UPDATE SET
    name = excluded.name,
    lat = excluded.lat,
    lng = excluded.lng
`);

for (const conf of NODES_CONFIG) {
  seedNodeStmt.run({
    nodeId: conf.nodeId || conf.id,
    name: conf.name,
    lat: conf.lat,
    lng: conf.lng
  });
}

// Prune any legacy nodes not in nodes.config.json
const configuredNodeIds = NODES_CONFIG.map(c => c.nodeId || c.id);
const placeholders = configuredNodeIds.map(() => '?').join(',');
db.prepare(`DELETE FROM nodes WHERE nodeId NOT IN (${placeholders})`).run(...configuredNodeIds);

// Prepared statements for high performance
const insertReadingStmt = db.prepare(`
  INSERT INTO readings (nodeId, lat, lng, temp, humidity, smoke, flame, status, score, createdAt, co2, windSpeed, windDir)
  VALUES (@nodeId, @lat, @lng, @temp, @humidity, @smoke, @flame, @status, @score, @createdAt, @co2, @windSpeed, @windDir)
`);

const upsertNodeStmt = db.prepare(`
  INSERT INTO nodes (nodeId, name, lat, lng, temp, humidity, smoke, flame, status, score, lastSeen, co2, windSpeed, windDir)
  VALUES (@nodeId, @name, @lat, @lng, @temp, @humidity, @smoke, @flame, @status, @score, @lastSeen, @co2, @windSpeed, @windDir)
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
    lastSeen = excluded.lastSeen,
    co2 = excluded.co2,
    windSpeed = excluded.windSpeed,
    windDir = excluded.windDir
`);

const getNodeStmt = db.prepare(`SELECT * FROM nodes WHERE nodeId = ?`);
const getAllNodesStmt = db.prepare(`SELECT * FROM nodes ORDER BY nodeId ASC`);

const insertAlertStmt = db.prepare(`
  INSERT INTO alerts (nodeId, status, lat, lng, message, time, acknowledged, satelliteConfirmed, distance, spreadEstimate)
  VALUES (@nodeId, @status, @lat, @lng, @message, @time, 0, @satelliteConfirmed, @distance, @spreadEstimate)
`);

const getAlertsStmt = db.prepare(`
  SELECT * FROM alerts ORDER BY id DESC LIMIT 50
`);

const getHistoryStmt = db.prepare(`
  SELECT * FROM (
    SELECT id, nodeId, temp, humidity, smoke, flame, status, score, createdAt, co2, windSpeed, windDir
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

// Compass and Geodesy Bearing Helpers
function degreesToCompass(deg) {
  const val = Math.floor(((deg % 360) / 45) + 0.5);
  const arr = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return arr[val % 8];
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (θ * 180 / Math.PI + 360) % 360;
}

// Compute Spread Estimate for FIRE alerts (Demo/Simulated)
function computeSpreadEstimate(lat, lng, fireNodeId, windSpeed, windDir) {
  if (windSpeed == null || windDir == null) return null;

  const spreadBearing = (Math.round(windDir) + 180) % 360;
  const fromCompass = degreesToCompass(windDir);
  const spreadCompass = degreesToCompass(spreadBearing);

  // Downwind nodes = registered nodes within 10 km and within 45 degrees of the spread bearing
  const downwindNodes = [];
  const registeredNodes = getAllNodesStmt ? getAllNodesStmt.all() : NODES_CONFIG;
  for (const node of registeredNodes) {
    const id = node.nodeId || node.id;
    if (id === fireNodeId) continue;

    const dist = haversineDistanceKm(lat, lng, node.lat, node.lng);
    if (dist <= 10.0) {
      const bearing = calculateBearing(lat, lng, node.lat, node.lng);
      let diff = Math.abs(bearing - spreadBearing) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff <= 45.0) {
        downwindNodes.push(id);
      }
    }
  }

  const downwindStr = downwindNodes.length > 0 ? downwindNodes.join(', ') : 'None';
  return `Wind: from ${fromCompass} at ${Math.round(windSpeed)} km/h. Likely spread toward ${spreadCompass}. Nodes downwind: ${downwindStr}.`;
}

// Risk calculation & status evaluation
function computeStatusAndScore(temp, humidity, smoke, flame, co2 = null, windSpeed = null) {
  const isFlame = Boolean(flame);
  const isDirectFire = isFlame || (smoke > 60 && temp > 50);
  const isCo2Fire = (co2 != null && co2 > 1500 && smoke > 40);
  const isFire = isDirectFire || isCo2Fire;

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

  // CO2 scoring: co2 > 600 => +15, co2 > 1000 => +30
  if (co2 != null) {
    if (co2 > 1000) {
      score += 30;
    } else if (co2 > 600) {
      score += 15;
    }
  }

  // Wind scoring: Wind never creates an alert by itself. If wind speed > 20 km/h, add +10 to the score only when another factor is already above zero
  if (windSpeed != null && windSpeed > 20 && score > 0) {
    score += 10;
  }

  score = Math.min(100, score);

  if (isFire) {
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

  const co2Text = alertData.co2 != null ? `\n• CO2 Level: ${alertData.co2} ppm _(Simulated)_` : '';
  const spreadText = alertData.spreadEstimate ? `\n• ${alertData.spreadEstimate} _(Simulated)_` : '';

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
• Flame Detected: ${alertData.flame ? 'YES 🔥' : 'NO'}${co2Text}
• Risk Score: ${alertData.score}/100
• ${satText}${spreadText}

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

// Mark a node offline immediately (called by watchdog, /api/nodes/:nodeId/kill, or /api/readings with status OFFLINE)
async function markNodeOffline(nodeId, customReason, skipTelegram = false) {
  const node = getNodeStmt.get(nodeId);
  if (!node) return null;

  const now = Date.now();
  const outage = getOrCreateOutage(nodeId);
  const hasReported = typeof node.lastSeen === 'number' && node.lastSeen > 0;

  outage.isOffline = true;
  outage.offlineSince = hasReported ? node.lastSeen : now;

  // Mark node OFFLINE in database
  db.prepare(`UPDATE nodes SET status = 'OFFLINE' WHERE nodeId = ?`).run(nodeId);

  // Broadcast node status change over SSE immediately
  broadcastSSE('node_status', {
    nodeId: node.nodeId,
    status: 'OFFLINE',
    lastSeen: node.lastSeen
  });

  // Check if fault alert already exists
  const existingFaultAlert = db.prepare(`
    SELECT id FROM alerts
    WHERE nodeId = ? AND status = 'SENSOR_FAULT' AND acknowledged = 0 AND (message LIKE '%OFFLINE%' OR message LIKE '%no data%' OR message LIKE '%transmission stopped%')
    ORDER BY id DESC LIMIT 1
  `).get(node.nodeId);

  let alertRecord = null;
  if (!existingFaultAlert) {
    const timeIso = new Date(now).toISOString();
    const nodeName = node.name || KNOWN_NODES[node.nodeId]?.name;
    const nodeLabel = nodeName ? `${node.nodeId} (${nodeName})` : node.nodeId;
    const nearestResponder = getNearestResponder(node.lat, node.lng);
    const faultMessage = customReason || (hasReported
      ? `SENSOR OFFLINE: ${nodeLabel} has sent no data for ${NODE_TIMEOUT_SECONDS}s.`
      : `SENSOR OFFLINE: ${nodeLabel} never reported data.`);

    const alertResult = insertAlertStmt.run({
      nodeId: node.nodeId,
      status: 'SENSOR_FAULT',
      lat: node.lat,
      lng: node.lng,
      message: faultMessage,
      time: timeIso,
      satelliteConfirmed: 0,
      distance: null,
      spreadEstimate: null
    });

    outage.alertRecordId = alertResult.lastInsertRowid;

    alertRecord = {
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
      spreadEstimate: null,
      nearestResponder,
      suggestedAction: 'Inspect sensor hardware, battery, and radio connectivity in field',
      temp: node.temp,
      humidity: node.humidity,
      smoke: node.smoke,
      flame: Boolean(node.flame),
      co2: node.co2,
      windSpeed: node.windSpeed,
      windDir: node.windDir,
      score: 0
    };

    broadcastSSE('alert', alertRecord);
  }

  if (!skipTelegram) {
    sendOfflineTelegramMessage(node, outage, now).catch(() => {});
  }

  return { ok: true, nodeId, status: 'OFFLINE', alert: alertRecord };
}

// Mark a node revived (called by /api/nodes/:nodeId/revive or recovery in /api/readings)
function markNodeRevived(nodeId) {
  const node = getNodeStmt.get(nodeId);
  if (!node) return null;

  const now = Date.now();
  const outage = getOrCreateOutage(nodeId);
  const outageMs = outage.offlineSince ? (now - outage.offlineSince) : 0;
  const outageMin = Math.max(1, Math.round(outageMs / 60000));

  outage.isOffline = false;
  outage.offlineSince = 0;
  outage.lastAlertSentTime = 0;
  outage.alertRecordId = null;

  // Clear offline fault alerts
  db.prepare(`
    DELETE FROM alerts
    WHERE nodeId = ? AND status = 'SENSOR_FAULT' AND (message LIKE '%OFFLINE%' OR message LIKE '%no data%' OR message LIKE '%transmission stopped%')
  `).run(nodeId);

  // Mark node NORMAL with fresh lastSeen
  db.prepare(`UPDATE nodes SET status = 'NORMAL', lastSeen = ? WHERE nodeId = ?`).run(now, nodeId);

  // Broadcast recovery over SSE
  broadcastSSE('node_status', {
    nodeId,
    status: 'NORMAL',
    lastSeen: now
  });
  broadcastSSE('alert_clear', { nodeId, status: 'SENSOR_FAULT' });

  const recoveryText = `SENSOR RECOVERED: ${nodeId} is back online after ${outageMin} min`;
  sendTelegramMessage(recoveryText).catch(() => {});

  return { ok: true, nodeId, status: 'NORMAL' };
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
        await markNodeOffline(node.nodeId, null, inGracePeriod);
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

// Telegram configuration check & test endpoint
app.get('/api/telegram-test', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(400).json({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in environment variables.',
      configured: {
        hasBotToken: Boolean(TELEGRAM_BOT_TOKEN),
        hasChatId: Boolean(TELEGRAM_CHAT_ID)
      }
    });
  }

  const testMessage = `🌲 *WildHack FireWatch - Test Notification*\n\n✅ Telegram dispatcher is working properly!\n⏰ Time: ${new Date().toISOString()}`;
  const result = await sendTelegramMessage(testMessage, { parse_mode: 'Markdown' });

  if (result && result.ok) {
    return res.json({
      ok: true,
      message: 'Test message sent successfully to Telegram!',
      result
    });
  }

  return res.status(502).json({
    ok: false,
    error: 'Telegram API rejected message',
    details: result
  });
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

  const { nodeId, lat, lng, temp, humidity, smoke, flame, name, co2, windSpeed, windDir, status: reqStatus, killed } = req.body;

  // Basic nodeId check
  if (!nodeId || typeof nodeId !== 'string') {
    return res.status(400).json({ error: 'nodeId is required and must be a string' });
  }

  // Handle immediate offline/kill signal
  if (reqStatus === 'OFFLINE' || killed === true) {
    const offlineResult = await markNodeOffline(nodeId, `SENSOR OFFLINE: ${nodeId} killed.`);
    if (offlineResult) {
      return res.status(200).json(offlineResult);
    }
  }

  const now = Date.now();
  const timeIso = new Date(now).toISOString();
  const existingNode = getNodeStmt.get(nodeId);

  // Field-level fault helper (ignores out-of-range field, flags sensor fault for that field only)
  function flagFieldFault(fieldName, faultReason) {
    const validLat = (typeof lat === 'number' && !isNaN(lat)) ? lat : (existingNode?.lat || KNOWN_NODES[nodeId]?.lat || 0);
    const validLng = (typeof lng === 'number' && !isNaN(lng)) ? lng : (existingNode?.lng || KNOWN_NODES[nodeId]?.lng || 0);
    const nearest = getNearestResponder(validLat, validLng);
    const faultMsg = `SENSOR_FAULT: possible sensor malfunction on ${nodeId} (${faultReason})`;

    const recentFault = db.prepare(`
      SELECT id FROM alerts
      WHERE nodeId = ? AND status = 'SENSOR_FAULT' AND message LIKE ? AND acknowledged = 0
      ORDER BY id DESC LIMIT 1
    `).get(nodeId, `%${fieldName}%`);

    if (!recentFault) {
      const alertResult = insertAlertStmt.run({
        nodeId,
        status: 'SENSOR_FAULT',
        lat: validLat,
        lng: validLng,
        message: faultMsg,
        time: timeIso,
        satelliteConfirmed: 0,
        distance: null,
        spreadEstimate: null
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
        spreadEstimate: null,
        nearestResponder: nearest,
        suggestedAction: `Inspect and recalibrate ${fieldName} sensor hardware in field`,
        temp: typeof temp === 'number' && !isNaN(temp) ? temp : null,
        humidity: typeof humidity === 'number' && !isNaN(humidity) ? humidity : null,
        smoke: typeof smoke === 'number' && !isNaN(smoke) ? smoke : null,
        flame: Boolean(flame),
        co2: null,
        windSpeed: null,
        windDir: null,
        score: 0
      });
    }
  }

  let cleanCo2 = null;
  let cleanWindSpeed = null;
  let cleanWindDir = null;

  // Validate co2 (ppm, valid 300-5000)
  if (co2 !== undefined && co2 !== null) {
    if (typeof co2 !== 'number' || isNaN(co2) || co2 < 300 || co2 > 5000) {
      flagFieldFault('co2', `co2 value ${co2} ppm outside valid range (300..5000)`);
    } else {
      cleanCo2 = Math.round(co2 * 10) / 10;
    }
  }

  // Validate windSpeed (km/h, 0-150)
  if (windSpeed !== undefined && windSpeed !== null) {
    if (typeof windSpeed !== 'number' || isNaN(windSpeed) || windSpeed < 0 || windSpeed > 150) {
      flagFieldFault('windSpeed', `windSpeed value ${windSpeed} km/h outside valid range (0..150)`);
    } else {
      cleanWindSpeed = Math.round(windSpeed * 10) / 10;
    }
  }

  // Validate windDir (degrees 0-359, direction the wind comes FROM)
  if (windDir !== undefined && windDir !== null) {
    if (typeof windDir !== 'number' || isNaN(windDir) || windDir < 0 || windDir > 359) {
      flagFieldFault('windDir', `windDir value ${windDir}° outside valid range (0..359)`);
    } else {
      cleanWindDir = Math.round(windDir * 10) / 10;
    }
  }

  // 6. Reading-level faults check for mandatory baseline sensors (temp, humidity, smoke)
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
        distance: null,
        spreadEstimate: null
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
        spreadEstimate: null,
        nearestResponder,
        suggestedAction: 'Inspect and recalibrate sensor hardware in field',
        temp: typeof temp === 'number' && !isNaN(temp) ? temp : null,
        humidity: typeof humidity === 'number' && !isNaN(humidity) ? humidity : null,
        smoke: typeof smoke === 'number' && !isNaN(smoke) ? smoke : null,
        flame: Boolean(flame),
        co2: cleanCo2,
        windSpeed: cleanWindSpeed,
        windDir: cleanWindDir,
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
    markNodeRevived(nodeId);
  }

  const parsedFlame = Boolean(flame);

  // Compute status and risk score with CO2 and Wind support for this reading
  const { status, score } = computeStatusAndScore(temp, humidity, smoke, parsedFlame, cleanCo2, cleanWindSpeed);

  // Check previous status for alert transition
  const prevStatus = existingNode ? existingNode.status : null;

  // Nearest responder
  const nearestResponder = getNearestResponder(lat, lng);

  // Spread estimate for FIRE alerts (Demo/Simulated)
  const spreadEstimate = (status === 'FIRE' && cleanWindSpeed != null && cleanWindDir != null)
    ? computeSpreadEstimate(lat, lng, nodeId, cleanWindSpeed, cleanWindDir)
    : null;

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
    createdAt: timeIso,
    co2: cleanCo2,
    windSpeed: cleanWindSpeed,
    windDir: cleanWindDir
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
    lastSeen: now,
    co2: cleanCo2,
    windSpeed: cleanWindSpeed,
    windDir: cleanWindDir
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

    let message = status === 'FIRE'
      ? `CRITICAL: Active fire detected at ${nodeId}! Flame/Smoke spike observed.`
      : `WARNING: High fire risk at ${nodeId} (Score: ${score}/100). Extreme dry/hot conditions.`;

    if (spreadEstimate) {
      message += ` ${spreadEstimate}`;
    }

    const alertResult = insertAlertStmt.run({
      nodeId,
      status,
      lat,
      lng,
      message,
      time: timeIso,
      satelliteConfirmed: satelliteConfirmed ? 1 : 0,
      distance,
      spreadEstimate
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
      spreadEstimate,
      nearestResponder,
      suggestedAction: actionText,
      temp,
      humidity,
      smoke,
      flame: parsedFlame,
      co2: cleanCo2,
      windSpeed: cleanWindSpeed,
      windDir: cleanWindDir,
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
    co2: cleanCo2,
    windSpeed: cleanWindSpeed,
    windDir: cleanWindDir,
    spreadEstimate,
    status,
    rawStatus: status,
    score,
    lastSeen: now,
    nearestResponder
  });

  return res.status(200).json({
    status,
    score,
    co2: cleanCo2,
    windSpeed: cleanWindSpeed,
    windDir: cleanWindDir,
    spreadEstimate
  });
});

// Get latest state of all nodes (marking nodes offline if no data for NODE_TIMEOUT_SECONDS)
app.get('/api/nodes', (req, res) => {
  const nodes = getAllNodesStmt.all();
  const now = Date.now();

  const enrichedNodes = nodes.map(node => {
    const isOffline = !node.lastSeen || (now - node.lastSeen) > NODE_TIMEOUT_MS;
    const effectiveStatus = isOffline ? 'OFFLINE' : node.status;
    const nearest = getNearestResponder(node.lat, node.lng);
    const conf = KNOWN_NODES[node.nodeId] || {};

    const spreadEstimate = (effectiveStatus === 'FIRE' && node.windSpeed != null && node.windDir != null)
      ? computeSpreadEstimate(node.lat, node.lng, node.nodeId, node.windSpeed, node.windDir)
      : null;

    return {
      ...node,
      name: node.name || conf.name || null,
      zone: conf.zone || null,
      riskLevel: conf.riskLevel || 'MEDIUM',
      reason: conf.reason || null,
      flame: Boolean(node.flame),
      co2: node.co2 != null ? node.co2 : null,
      windSpeed: node.windSpeed != null ? node.windSpeed : null,
      windDir: node.windDir != null ? node.windDir : null,
      spreadEstimate,
      status: effectiveStatus,
      rawStatus: node.status,
      isOffline,
      nearestResponder: nearest
    };
  });

  res.json(enrichedNodes);
});

// Explicit Kill Node endpoint (Simulator / Dashboard / API)
app.post('/api/nodes/:nodeId/kill', async (req, res) => {
  const { nodeId } = req.params;
  const result = await markNodeOffline(nodeId, `SENSOR OFFLINE: ${nodeId} killed.`);
  if (!result) {
    return res.status(404).json({ error: `Node ${nodeId} not found` });
  }
  return res.json(result);
});

// Explicit Revive Node endpoint (Simulator / Dashboard / API)
app.post('/api/nodes/:nodeId/revive', (req, res) => {
  const { nodeId } = req.params;
  const result = markNodeRevived(nodeId);
  if (!result) {
    return res.status(404).json({ error: `Node ${nodeId} not found` });
  }
  return res.json(result);
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
      spreadEstimate: alert.spreadEstimate || null,
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
  console.log(`📱 Telegram Alerts: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'Enabled ✅' : 'Disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)'}`);
  if (FIRMS_MAP_KEY) {
    console.log(`🛰️ NASA FIRMS: Active verification enabled`);
    fetchHotspots().catch(() => {});
  }
  console.log(`-------------------------------------------------------`);
  console.log(`📍 Registered Sensor Nodes (${NODES_CONFIG.length} grid nodes):`);
  for (const node of NODES_CONFIG) {
    let nearestDist = Infinity;
    let nearestNodeId = '';
    for (const other of NODES_CONFIG) {
      if ((other.nodeId || other.id) !== (node.nodeId || node.id)) {
        const d = haversineDistanceKm(node.lat, node.lng, other.lat, other.lng);
        if (d < nearestDist) {
          nearestDist = d;
          nearestNodeId = other.nodeId || other.id;
        }
      }
    }
    console.log(`   • ${node.nodeId || node.id} | ${node.name} | lat: ${node.lat}, lng: ${node.lng} | nearest neighbour: ${nearestDist} km (${nearestNodeId})`);
  }
  console.log(`=======================================================`);
});
