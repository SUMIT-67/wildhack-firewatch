/**
 * WildHack FireWatch - Software Sensor Simulator
 * Simulates 4 IoT sensor nodes across Tadoba Andhari Tiger Reserve (TATR)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'wildhack-secret';

// Load sensor nodes from nodes.config.json
const configPath = path.join(__dirname, '..', 'nodes.config.json');
let nodesConfig = [];
try {
  nodesConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`[!] Failed to load ${configPath}:`, err.message);
  process.exit(1);
}

const NODES = {};
for (const conf of nodesConfig) {
  const letter = (conf.nodeId || conf.id).replace('NODE-', '').toUpperCase();
  NODES[letter] = {
    nodeId: conf.nodeId || conf.id,
    name: conf.name,
    lat: conf.lat,
    lng: conf.lng,
    zone: conf.zone,
    riskLevel: conf.riskLevel,
    reason: conf.reason,
    override: null,
    killed: false
  };
}

// Generate normal values with slight random drift
function generateNormalReading(nodeKey) {
  // Base normal baseline
  const baseTemp = 29.0 + (nodeKey.charCodeAt(0) % 3);
  const baseHum = 54.0 - (nodeKey.charCodeAt(0) % 4);
  const baseSmoke = 7.0 + (nodeKey.charCodeAt(0) % 2);

  const driftTemp = (Math.random() - 0.5) * 1.5;
  const driftHum = (Math.random() - 0.5) * 2.0;
  const driftSmoke = (Math.random() - 0.5) * 1.8;

  return {
    temp: Math.round((baseTemp + driftTemp) * 10) / 10,
    humidity: Math.round(Math.max(10, Math.min(95, baseHum + driftHum)) * 10) / 10,
    smoke: Math.round(Math.max(0, Math.min(100, baseSmoke + driftSmoke)) * 10) / 10,
    flame: false
  };
}

// Generate reading considering overrides
function getReading(nodeKey) {
  const node = NODES[nodeKey];
  if (!node.override) {
    return generateNormalReading(nodeKey);
  }

  if (node.override === 'FIRE') {
    return {
      temp: Math.round((62.0 + Math.random() * 8) * 10) / 10,
      humidity: Math.round((14.0 + Math.random() * 5) * 10) / 10,
      smoke: Math.round((75.0 + Math.random() * 20) * 10) / 10,
      flame: true
    };
  }

  if (node.override === 'WARN') {
    return {
      temp: Math.round((46.0 + Math.random() * 3) * 10) / 10,
      humidity: Math.round((22.0 + Math.random() * 5) * 10) / 10,
      smoke: Math.round((42.0 + Math.random() * 6) * 10) / 10,
      flame: false
    };
  }

  return generateNormalReading(nodeKey);
}

// Post reading to backend
async function sendReading(nodeKey) {
  const node = NODES[nodeKey];
  if (node.killed) {
    return;
  }

  const reading = getReading(nodeKey);

  const payload = {
    nodeId: node.nodeId,
    name: node.name,
    lat: node.lat,
    lng: node.lng,
    temp: reading.temp,
    humidity: reading.humidity,
    smoke: reading.smoke,
    flame: reading.flame
  };

  try {
    const res = await fetch(`${SERVER_URL}/api/readings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`[!] ${node.nodeId} failed (${res.status}): ${errText}`);
      return;
    }

    const data = await res.json();
    const tag = data.status === 'FIRE' ? '🔥 FIRE' : data.status === 'WARNING' ? '⚠️ WARN' : data.status === 'SENSOR_FAULT' ? '⚡ FAULT' : '🟢 NORM';
    const flameText = payload.flame ? 'FLAME:YES' : 'FLAME:no';
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    console.log(`[${timeStr} IST] ${node.nodeId} (${node.name}): ${tag} | Temp: ${payload.temp}°C, Hum: ${payload.humidity}%, Smoke: ${payload.smoke}%, ${flameText} | Score: ${data.score}`);
  } catch (err) {
    console.log(`[!] Error sending ${node.nodeId}: ${err.message}`);
  }
}

// Tick loop (every 5 seconds)
async function tick() {
  for (const key of Object.keys(NODES)) {
    if (!NODES[key].killed) {
      await sendReading(key);
    }
  }
}

function getValidLetters() {
  return Object.keys(NODES).sort().join('|');
}

function printHelp() {
  const letters = getValidLetters();
  console.log(`
--- WildHack FireWatch Simulator Commands ---
  fire <${letters}>   -> Trigger FIRE on specific node (e.g., 'fire A')
  warn <${letters}>   -> Trigger WARNING on specific node (e.g., 'warn B')
  kill <${letters}>   -> Kill node (stops transmitting telemetry, simulates offline)
  revive <${letters}> -> Revive node (resumes transmitting telemetry, simulates recovery)
  clear [${letters}]  -> Reset node override (or all nodes if letter omitted) to normal
  status           -> Display current status of all virtual nodes
  help             -> Show this help guide
  exit / quit      -> Stop simulator
---------------------------------------------
`);
}

function printStatus() {
  console.log(`\n=== Current Virtual Node States ===`);
  for (const [key, node] of Object.entries(NODES)) {
    let state = node.override ? `OVERRIDE: ${node.override}` : 'NORMAL (Baseline)';
    if (node.killed) {
      state = '💀 KILLED (Transmission stopped / offline)';
    }
    console.log(`  [${key}] ${node.nodeId} (${node.name}): ${state}`);
  }
  console.log(`===================================\n`);
}

// Setup interactive CLI
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'firewatch-sim> '
});

rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const target = parts[1]?.toUpperCase();

  switch (cmd) {
    case 'fire':
      if (target && NODES[target]) {
        NODES[target].override = 'FIRE';
        console.log(`🚨 Triggered FIRE on ${NODES[target].nodeId}! Next post will transmit flame & high heat.`);
        sendReading(target);
      } else {
        console.log(`Usage: fire <${getValidLetters()}>`);
      }
      break;

    case 'warn':
      if (target && NODES[target]) {
        NODES[target].override = 'WARN';
        console.log(`⚠️ Triggered WARNING on ${NODES[target].nodeId}! Next post will transmit warning conditions.`);
        sendReading(target);
      } else {
        console.log(`Usage: warn <${getValidLetters()}>`);
      }
      break;

    case 'kill':
      if (target && NODES[target]) {
        NODES[target].killed = true;
        console.log(`💀 Node ${NODES[target].nodeId} (${NODES[target].name}) KILLED! Stopped transmitting telemetry.`);
      } else {
        console.log(`Usage: kill <${getValidLetters()}>`);
      }
      break;

    case 'revive':
      if (target && NODES[target]) {
        NODES[target].killed = false;
        console.log(`✨ Node ${NODES[target].nodeId} (${NODES[target].name}) REVIVED! Resuming telemetry transmission.`);
        sendReading(target);
      } else {
        console.log(`Usage: revive <${getValidLetters()}>`);
      }
      break;

    case 'clear':
      if (target && NODES[target]) {
        NODES[target].override = null;
        console.log(`✅ Cleared override on ${NODES[target].nodeId}. Returning to normal baseline.`);
        sendReading(target);
      } else {
        for (const k of Object.keys(NODES)) {
          NODES[k].override = null;
        }
        console.log(`✅ Cleared overrides on ALL nodes.`);
      }
      break;

    case 'status':
      printStatus();
      break;

    case 'help':
      printHelp();
      break;

    case 'exit':
    case 'quit':
      console.log('Exiting simulator...');
      process.exit(0);
      break;

    default:
      if (line.trim()) {
        console.log(`Unknown command: "${line.trim()}". Type "help" for instructions.`);
      }
      break;
  }
  rl.prompt();
});

console.log(`===========================================================`);
console.log(`🌲 WildHack FireWatch Simulator Started`);
console.log(`🎯 Target: ${SERVER_URL}/api/readings`);
console.log(`🛰️ Transmitting telemetry for ${Object.keys(NODES).length} nodes every 5 seconds`);
console.log(`===========================================================`);
printHelp();
rl.prompt();

// First tick immediately, then every 5 seconds
tick();
setInterval(tick, 5000);
