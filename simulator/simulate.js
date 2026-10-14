/**
 * WildHack FireWatch - Software Sensor Simulator
 * Simulates 4 IoT sensor nodes across Tadoba Andhari Tiger Reserve (TATR)
 */

const readline = require('readline');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'wildhack-secret';

// Sensor nodes located across Tadoba Andhari Tiger Reserve
const NODES = {
  A: {
    nodeId: 'NODE-A',
    name: 'Moharli Core Buffer',
    lat: 20.2215,
    lng: 79.3320,
    override: null
  },
  B: {
    nodeId: 'NODE-B',
    name: 'Kolsa Southern Range',
    lat: 20.1980,
    lng: 79.4120,
    override: null
  },
  C: {
    nodeId: 'NODE-C',
    name: 'Tadoba Lake Ridge',
    lat: 20.2680,
    lng: 79.3250,
    override: null
  },
  D: {
    nodeId: 'NODE-D',
    name: 'Kolara Northern Gate',
    lat: 20.3340,
    lng: 79.3680,
    override: null
  }
};

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
  const reading = getReading(nodeKey);

  const payload = {
    nodeId: node.nodeId,
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
    const tag = data.status === 'FIRE' ? '🔥 FIRE' : data.status === 'WARNING' ? '⚠️ WARN' : '🟢 NORM';
    const flameText = payload.flame ? 'FLAME:YES' : 'FLAME:no';
    console.log(`[${new Date().toLocaleTimeString()}] ${node.nodeId} (${node.name}): ${tag} | Temp: ${payload.temp}°C, Hum: ${payload.humidity}%, Smoke: ${payload.smoke}%, ${flameText} | Score: ${data.score}`);
  } catch (err) {
    console.log(`[!] Error sending ${node.nodeId}: ${err.message}`);
  }
}

// Tick loop (every 5 seconds)
async function tick() {
  for (const key of Object.keys(NODES)) {
    await sendReading(key);
  }
}

function printHelp() {
  console.log(`
--- WildHack FireWatch Simulator Commands ---
  fire <A|B|C|D>   -> Trigger FIRE on specific node (e.g., 'fire A')
  warn <A|B|C|D>   -> Trigger WARNING on specific node (e.g., 'warn B')
  clear [A|B|C|D]  -> Reset node (or all nodes if letter omitted) to normal
  status           -> Display current status of all virtual nodes
  help             -> Show this help guide
  exit / quit      -> Stop simulator
---------------------------------------------
`);
}

function printStatus() {
  console.log(`\n=== Current Virtual Node States ===`);
  for (const [key, node] of Object.entries(NODES)) {
    const state = node.override ? `OVERRIDE: ${node.override}` : 'NORMAL (Baseline)';
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
        console.log(`Usage: fire <A|B|C|D>`);
      }
      break;

    case 'warn':
      if (target && NODES[target]) {
        NODES[target].override = 'WARN';
        console.log(`⚠️ Triggered WARNING on ${NODES[target].nodeId}! Next post will transmit warning conditions.`);
        sendReading(target);
      } else {
        console.log(`Usage: warn <A|B|C|D>`);
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
console.log(`🛰️ Transmitting telemetry for 4 nodes every 5 seconds`);
console.log(`===========================================================`);
printHelp();
rl.prompt();

// First tick immediately, then every 5 seconds
tick();
setInterval(tick, 5000);
