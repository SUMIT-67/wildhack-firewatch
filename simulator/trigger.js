/**
 * WildHack FireWatch - One-shot Node Trigger CLI
 * Manually trigger FIRE, WARN, or NORMAL on any node via terminal
 * 
 * Usage:
 *   node simulator/trigger.js fire A [--render]
 *   node simulator/trigger.js warn B [--render]
 *   node simulator/trigger.js clear A [--render]
 */

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'nodes.config.json');
let nodesConfig = [];
try {
  nodesConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`[!] Failed to load ${configPath}:`, err.message);
  process.exit(1);
}

const args = process.argv.slice(2);
const isRender = args.includes('--render') || args.includes('--remote');
const directUrl = args.find(a => a.startsWith('http://') || a.startsWith('https://'));
const RENDER_URL = 'https://wildhack-firewatch.onrender.com';
const SERVER_URL = process.env.SERVER_URL || directUrl || (isRender ? RENDER_URL : 'http://localhost:3000');
const API_KEY = process.env.API_KEY || 'wildhack-secret';

// Non-flag arguments
const positionalArgs = args.filter(a => !a.startsWith('--') && !a.startsWith('http://') && !a.startsWith('https://'));
const knownActions = ['fire', 'warn', 'clear', 'normal'];
let action = 'fire';
let nodeArg = 'A';

if (positionalArgs.length === 1) {
  if (knownActions.includes(positionalArgs[0].toLowerCase())) {
    action = positionalArgs[0].toLowerCase();
  } else {
    nodeArg = positionalArgs[0].toUpperCase();
  }
} else if (positionalArgs.length >= 2) {
  if (knownActions.includes(positionalArgs[0].toLowerCase())) {
    action = positionalArgs[0].toLowerCase();
    nodeArg = positionalArgs[1].toUpperCase();
  } else {
    nodeArg = positionalArgs[0].toUpperCase();
    if (knownActions.includes(positionalArgs[1].toLowerCase())) {
      action = positionalArgs[1].toLowerCase();
    }
  }
}

const letter = nodeArg.replace('NODE-', '').trim();
const node = nodesConfig.find(n => 
  (n.nodeId || n.id).toUpperCase() === `NODE-${letter}` || 
  (n.nodeId || n.id).toUpperCase() === letter
);

if (!node) {
  const validLetters = nodesConfig.map(n => (n.nodeId || n.id).replace('NODE-', '')).join(', ');
  console.error(`[!] Node "${nodeArg}" not found. Available nodes: ${validLetters}`);
  process.exit(1);
}

let payload;
if (action === 'fire') {
  payload = {
    nodeId: node.nodeId || node.id,
    name: node.name,
    lat: node.lat,
    lng: node.lng,
    temp: 68.5,
    humidity: 14.0,
    smoke: 85.0,
    flame: true,
    co2: 1800, // Demo simulated high CO2
    windSpeed: 18.0, // Demo simulated wind (km/h)
    windDir: 315 // Demo simulated wind from NW (spread toward SE)
  };
} else if (action === 'warn') {
  payload = {
    nodeId: node.nodeId || node.id,
    name: node.name,
    lat: node.lat,
    lng: node.lng,
    temp: 46.5,
    humidity: 22.0,
    smoke: 42.0,
    flame: false,
    co2: 750, // Demo simulated CO2 (> 600 ppm)
    windSpeed: 12.0,
    windDir: 315
  };
} else if (action === 'clear' || action === 'normal') {
  payload = {
    nodeId: node.nodeId || node.id,
    name: node.name,
    lat: node.lat,
    lng: node.lng,
    temp: 29.5,
    humidity: 53.0,
    smoke: 7.2,
    flame: false,
    co2: 420, // Demo baseline CO2
    windSpeed: 8.0,
    windDir: 315
  };
} else {
  console.error(`[!] Unknown action "${action}". Available actions: fire, warn, clear`);
  process.exit(1);
}

async function run() {
  console.log(`[🚀] Triggering ${action.toUpperCase()} on ${node.nodeId || node.id} (${node.name})...`);
  console.log(`🎯 Destination: ${SERVER_URL}/api/readings`);
  try {
    const res = await fetch(`${SERVER_URL}/api/readings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      const emoji = data.status === 'FIRE' ? '🔥' : data.status === 'WARNING' ? '⚠️' : '🟢';
      console.log(`[✅] SUCCESS! Node ${node.nodeId || node.id} is now ${emoji} ${data.status} (Score: ${data.score})`);
    } else {
      console.error(`[!] Failed (${res.status}):`, data);
    }
  } catch (err) {
    console.error(`[❌] Network error: ${err.message}`);
  }
}

run();
