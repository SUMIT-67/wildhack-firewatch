/**
 * WildHack FireWatch - Frontend Application Logic
 * Real-time Telemetry, Leaflet GIS, Alert Management & Web Audio Alarm
 */

// Application State
const state = {
  nodes: new Map(),        // Map<nodeId, nodeData>
  alerts: [],              // Array of alerts
  responders: [],          // Array of responder posts
  hotspots: [],            // Array of NASA FIRMS satellite hotspots
  activePopupNodeId: null, // Currently open popup node ID
  popupChart: null,        // Active Chart.js instance in popup
  soundEnabled: true,      // Audio alarm enabled
  audioCtx: null,          // Web Audio API Context
  activeFireNode: null     // Current active fire node for banner
};

// ==========================================================================
// 1. LEAFLET MAP INITIALIZATION
// ==========================================================================
const TADOBA_COORDS = [20.25, 79.35];
const TADOBA_ZOOM = 11;

const map = L.map('map', {
  center: TADOBA_COORDS,
  zoom: TADOBA_ZOOM,
  zoomControl: true
});

// Real OpenStreetMap Tiles
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Tadoba Andhari Tiger Reserve'
}).addTo(map);

// Markers registry
const nodeMarkers = new Map();       // Map<nodeId, L.Marker>
const nodeCircles = new Map();       // Map<nodeId, L.Circle> (2 km risk circle under node)
const responderMarkers = new Map();  // Map<responderId, L.Marker>
const spreadCones = new Map();       // Map<nodeId, L.Polygon> (5 km 60 deg simulated spread cone)
const hotspotLayer = L.layerGroup().addTo(map); // Satellite layer (on by default)

// Layer toggle control for Satellite Hotspots
L.control.layers(null, { 'Satellite hotspots': hotspotLayer }, {
  position: 'topright',
  collapsed: false
}).addTo(map);

// Compass and Geodesy Bearing Helpers (Demo/Simulated)
function degreesToCompass(deg) {
  if (deg == null || isNaN(deg)) return '';
  const val = Math.floor(((deg % 360) / 45) + 0.5);
  const arr = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return arr[val % 8];
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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

function getDestinationLatLng(lat, lng, distKm, bearingDeg) {
  const R = 6371;
  const δ = distKm / R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lng * Math.PI / 180;

  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const sinθ = Math.sin(θ);
  const cosθ = Math.cos(θ);

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * cosθ;
  const φ2 = Math.asin(sinφ2);
  const y = sinθ * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);

  return [φ2 * 180 / Math.PI, λ2 * 180 / Math.PI];
}

function buildSpreadConeCoords(lat, lng, spreadBearing, distKm = 5.0, spreadAngle = 60) {
  const coords = [[lat, lng]]; // Apex at node
  const halfAngle = spreadAngle / 2; // 30 degrees
  const step = 5;
  for (let a = -halfAngle; a <= halfAngle; a += step) {
    const bearing = (spreadBearing + a + 360) % 360;
    coords.push(getDestinationLatLng(lat, lng, distKm, bearing));
  }
  coords.push([lat, lng]);
  return coords;
}

// Create Custom Node Marker HTML
function createNodeMarkerIcon(node) {
  const shortCode = node.nodeId.replace('NODE-', '');
  const statusClass = `status-${node.status}`;
  const isFireWithWind = node.status === 'FIRE' && node.windDir != null;
  const spreadBearing = node.windDir != null ? (node.windDir + 180) % 360 : null;

  const html = `
    <div class="node-marker-bubble ${statusClass}" title="${node.nodeId}: ${node.status}">
      ${shortCode}
      ${isFireWithWind ? `
        <span class="node-wind-arrow" style="transform: rotate(${spreadBearing}deg);" title="Wind from ${degreesToCompass(node.windDir)} (${Math.round(node.windSpeed || 0)} km/h), spreading toward ${degreesToCompass(spreadBearing)}">
          ▲
        </span>` : ''}
    </div>
  `;

  return L.divIcon({
    className: 'custom-node-icon',
    html: html,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14]
  });
}

// Create Responder Marker Icon (Blue station pin)
function createResponderMarkerIcon() {
  const html = `
    <div class="responder-marker-bubble" title="Forest Post / Watchtower">
      🏰
    </div>
  `;

  return L.divIcon({
    className: 'custom-node-icon',
    html: html,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14]
  });
}

// Create NASA FIRMS Satellite Hotspot Marker (Small orange diamond)
function createHotspotMarkerIcon() {
  return L.divIcon({
    className: 'custom-hotspot-icon',
    html: '<div class="hotspot-diamond" title="NASA FIRMS Satellite Hotspot"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    popupAnchor: [0, -8]
  });
}

// Build popup HTML for satellite hotspot
function buildHotspotPopupHTML(hs) {
  const dateStr = hs.acq_date || 'N/A';
  const timeStr = hs.acq_time
    ? (hs.acq_time.length === 4 ? `${hs.acq_time.slice(0, 2)}:${hs.acq_time.slice(2)} UTC` : `${hs.acq_time} UTC`)
    : 'N/A';
  const confStr = hs.confidence || 'N/A';
  const frpStr = hs.frp != null ? `${hs.frp} MW` : 'N/A';

  return `
    <div class="popup-container">
      <div class="popup-header">
        <div class="popup-title" style="color: #ea580c; font-size: 0.88rem;">🛰️ NASA FIRMS Hotspot</div>
        <span class="popup-badge" style="background: #fff7ed; color: #c2410c;">VIIRS</span>
      </div>
      <div class="popup-body">
        <div class="popup-grid">
          <div class="popup-stat">
            <div class="popup-stat-label">Date</div>
            <div class="popup-stat-val" style="font-size: 0.8rem;">${dateStr}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">Time</div>
            <div class="popup-stat-val" style="font-size: 0.8rem;">${timeStr}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">Confidence</div>
            <div class="popup-stat-val" style="font-size: 0.8rem; text-transform: capitalize;">${confStr}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">FRP</div>
            <div class="popup-stat-val" style="font-size: 0.8rem;">${frpStr}</div>
          </div>
        </div>
      </div>
      <div class="popup-footer" style="font-size: 0.72rem; color: var(--text-muted);">
        Coordinates: ${hs.latitude.toFixed(4)}, ${hs.longitude.toFixed(4)}
      </div>
    </div>
  `;
}

// Fetch NASA FIRMS Hotspots and render markers
async function fetchAndRenderHotspots() {
  try {
    const res = await fetch('/api/hotspots');
    if (!res.ok) return;
    const hotspots = await res.json();
    state.hotspots = hotspots;

    hotspotLayer.clearLayers();
    for (const hs of hotspots) {
      if (hs.latitude == null || hs.longitude == null) continue;
      const marker = L.marker([hs.latitude, hs.longitude], {
        icon: createHotspotMarkerIcon()
      });
      marker.bindPopup(buildHotspotPopupHTML(hs), {
        maxWidth: 280,
        className: 'node-custom-popup'
      });
      hotspotLayer.addLayer(marker);
    }
  } catch (err) {
    console.error('Failed to load satellite hotspots:', err);
  }
}

// ==========================================================================
// 2. WEB AUDIO API SYNTHESIZER ALARM
// ==========================================================================
function initAudioContext() {
  if (!state.audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      state.audioCtx = new AudioContext();
    }
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
}

// Short two-tone emergency alert beep
function playFireAlarmSound() {
  if (!state.soundEnabled) return;
  try {
    initAudioContext();
    if (!state.audioCtx) return;

    const ctx = state.audioCtx;
    const now = ctx.currentTime;

    // Tone 1: High alert beep (880 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.2);

    // Tone 2: Urgency response beep (988 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(988, now + 0.22);
    gain2.gain.setValueAtTime(0.35, now + 0.22);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.42);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.22);
    osc2.stop(now + 0.44);
  } catch (err) {
    console.warn('Web Audio beep error:', err);
  }
}

// ==========================================================================
// 3. POPUP CONTENT & CHART.JS INTEGRATION
// ==========================================================================
function buildNodePopupHTML(node) {
  const isOffline = node.status === 'OFFLINE';
  const badgeLabel = isOffline ? 'No signal' : node.status;
  const gmapsDirUrl = `https://www.google.com/maps/dir/?api=1&destination=${node.lat},${node.lng}`;
  const flameText = node.flame ? 'YES 🔥' : 'None';
  const flameClass = node.flame ? 'style="color:#dc2626; font-weight:700;"' : '';
  const lastSeenStr = formatTimeAgo(node.lastSeen);

  // CO2 metric
  const co2Val = node.co2 != null ? `${node.co2} ppm` : '415 ppm (Baseline)';
  const co2Class = (node.co2 != null && node.co2 > 1000) ? 'style="color:#dc2626; font-weight:700;"' : (node.co2 != null && node.co2 > 600) ? 'style="color:#d97706; font-weight:600;"' : '';

  // Wind metrics & spread calculations
  const speed = node.windSpeed != null ? Math.round(node.windSpeed) : 15;
  const dir = node.windDir != null ? Math.round(node.windDir) : 315;
  const fromCompass = degreesToCompass(dir) || 'NW';
  const spreadBearing = (dir + 180) % 360;
  const spreadCompass = degreesToCompass(spreadBearing) || 'SE';

  // Compute downwind nodes within 12 km and +/- 45 degrees of spread vector
  const downwindNodes = [];
  for (const other of state.nodes.values()) {
    if (other.nodeId === node.nodeId) continue;
    const d = calculateDistanceKm(node.lat, node.lng, other.lat, other.lng);
    if (d <= 12.0) {
      const b = calculateBearing(node.lat, node.lng, other.lat, other.lng);
      let diff = Math.abs(b - spreadBearing) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff <= 45.0) {
        downwindNodes.push(`${other.nodeId} (${d.toFixed(1)} km)`);
      }
    }
  }
  const downwindText = downwindNodes.length > 0 ? downwindNodes.join(', ') : 'None in direct 12 km corridor';

  return `
    <div class="popup-container">
      <div class="popup-header">
        <div class="popup-title">${node.nodeId}</div>
        <span class="popup-badge status-${node.status}">${badgeLabel}</span>
      </div>
      <div class="popup-body">
        <div class="popup-grid">
          <div class="popup-stat">
            <div class="popup-stat-label">Temperature</div>
            <div class="popup-stat-val">${node.temp != null ? node.temp + '°C' : '--'}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">Humidity</div>
            <div class="popup-stat-val">${node.humidity != null ? node.humidity + '%' : '--'}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">Smoke Level</div>
            <div class="popup-stat-val">${node.smoke != null ? node.smoke + '%' : '--'}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">Flame Sensor</div>
            <div class="popup-stat-val" ${flameClass}>${flameText}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">CO2 Level (Demo)</div>
            <div class="popup-stat-val" ${co2Class}>${co2Val}</div>
          </div>
          <div class="popup-stat">
            <div class="popup-stat-label">Prevailing Wind</div>
            <div class="popup-stat-val">${speed} km/h ${fromCompass}</div>
          </div>
        </div>

        <!-- Wind Region Covered & Spread Trajectory (Demo) -->
        <div class="popup-wind-section" style="margin-top: 8px; padding: 7px 10px; background: ${node.status === 'FIRE' ? 'rgba(220, 38, 38, 0.08)' : '#f8fafc'}; border: 1px solid ${node.status === 'FIRE' ? '#fca5a5' : '#e2e8f0'}; border-radius: 6px; font-size: 0.74rem;">
          <div style="font-weight: 700; color: ${node.status === 'FIRE' ? '#991b1b' : '#0f172a'}; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
            <span>${node.status === 'FIRE' ? '🔥 Active Spread Forecast' : '🌬️ Wind Region Covered (Demo)'}</span>
            <span style="font-size: 0.68rem; color: ${node.status === 'FIRE' ? '#b91c1c' : '#64748b'}; font-weight: 600;">5 km Cone (60°)</span>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 4px; color: #334155;">
            <div>From: <strong>${fromCompass} (${dir}°)</strong> @ ${speed} km/h</div>
            <div>Spread: <strong>Toward ${spreadCompass} (${spreadBearing}°)</strong></div>
          </div>
          <div style="color: #475569; margin-bottom: 2px;">
            Region Covered: <strong>~14.2 km² sector downwind</strong>
          </div>
          <div style="color: #475569;">
            Downwind In Path: <strong style="color: ${downwindNodes.length > 0 ? '#b91c1c' : '#059669'};">${downwindText}</strong>
          </div>
        </div>

        <div class="popup-chart-section">
          <div class="popup-chart-title">Telemetry Trend (Last 60 Readings)</div>
          <canvas id="popup-chart-canvas-${node.nodeId}" class="popup-chart-canvas"></canvas>
        </div>
      </div>
      <div class="popup-footer">
        <div class="popup-lastseen">Updated: <strong>${lastSeenStr}</strong></div>
        <a href="${gmapsDirUrl}" target="_blank" rel="noopener noreferrer" class="btn-nav-gmaps">
          <span>Navigate</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </a>
      </div>
    </div>
  `;
}

// Render or update Chart.js inside node popup
async function loadPopupChart(nodeId) {
  const canvas = document.getElementById(`popup-chart-canvas-${nodeId}`);
  if (!canvas) return;

  try {
    const res = await fetch(`/api/history/${nodeId}`);
    if (!res.ok) return;
    const history = await res.json();

    if (state.popupChart) {
      state.popupChart.destroy();
      state.popupChart = null;
    }

    // Prepare chart labels and datasets
    const labels = history.map((_, i) => `${i + 1}`);
    const tempData = history.map(h => h.temp);
    const smokeData = history.map(h => h.smoke);

    const ctx = canvas.getContext('2d');
    state.popupChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Temp (°C)',
            data: tempData,
            borderColor: '#f97316',
            backgroundColor: 'rgba(249, 115, 22, 0.08)',
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 0,
            fill: true
          },
          {
            label: 'Smoke (%)',
            data: smokeData,
            borderColor: '#64748b',
            backgroundColor: 'rgba(100, 116, 139, 0.05)',
            borderWidth: 1.5,
            tension: 0.35,
            pointRadius: 0,
            fill: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              boxWidth: 8,
              boxHeight: 8,
              font: { size: 9, family: 'Inter' }
            }
          },
          tooltip: {
            enabled: true,
            bodyFont: { size: 10 }
          }
        },
        scales: {
          x: { display: false },
          y: {
            display: true,
            ticks: {
              font: { size: 9 },
              maxTicksLimit: 4
            },
            grid: { color: '#f1f5f9' }
          }
        }
      }
    });
  } catch (err) {
    console.error('Failed to load popup chart:', err);
  }
}

// Attach popup events to marker
function bindNodePopup(marker, node) {
  marker.bindPopup(buildNodePopupHTML(node), {
    maxWidth: 320,
    className: 'node-custom-popup'
  });

  marker.on('popupopen', () => {
    state.activePopupNodeId = node.nodeId;
    setTimeout(() => {
      loadPopupChart(node.nodeId);
    }, 50);
  });

  marker.on('popupclose', () => {
    if (state.activePopupNodeId === node.nodeId) {
      state.activePopupNodeId = null;
      if (state.popupChart) {
        state.popupChart.destroy();
        state.popupChart = null;
      }
    }
  });
}

// ==========================================================================
// 4. MAP UPDATE LOGIC
// ==========================================================================
function updateMapNode(node) {
  const existingMarker = nodeMarkers.get(node.nodeId);

  if (existingMarker) {
    // Update marker position and custom icon
    existingMarker.setLatLng([node.lat, node.lng]);
    existingMarker.setIcon(createNodeMarkerIcon(node));

    // Update popup HTML
    const popup = existingMarker.getPopup();
    if (popup) {
      popup.setContent(buildNodePopupHTML(node));
    }

    // If popup currently open for this node, refresh chart
    if (state.activePopupNodeId === node.nodeId) {
      loadPopupChart(node.nodeId);
    }
  } else {
    // Create new marker
    const marker = L.marker([node.lat, node.lng], {
      icon: createNodeMarkerIcon(node)
    }).addTo(map);

    bindNodePopup(marker, node);
    nodeMarkers.set(node.nodeId, marker);
  }

  // Update spread cone for FIRE node with wind data (Demo/Simulated)
  const isFireWithWind = node.status === 'FIRE' && node.windDir != null;
  if (isFireWithWind) {
    const spreadBearing = (node.windDir + 180) % 360;
    const coneCoords = buildSpreadConeCoords(node.lat, node.lng, spreadBearing, 5.0, 60);
    let cone = spreadCones.get(node.nodeId);
    if (cone) {
      cone.setLatLngs(coneCoords);
    } else {
      cone = L.polygon(coneCoords, {
        color: '#dc2626',
        weight: 1.5,
        fillColor: '#ef4444',
        fillOpacity: 0.28,
        dashArray: '4, 4'
      }).addTo(map);
      cone.bindTooltip(`🔥 Predicted Fire Spread (Demo): 5 km cone toward ${degreesToCompass(spreadBearing)} (${spreadBearing}°)`, { sticky: true });
      spreadCones.set(node.nodeId, cone);
    }
  } else {
    const cone = spreadCones.get(node.nodeId);
    if (cone) {
      map.removeLayer(cone);
      spreadCones.delete(node.nodeId);
    }
  }
}

// Add static ranger / watchtower markers
function renderResponders(responders) {
  for (const r of responders) {
    const marker = L.marker([r.lat, r.lng], {
      icon: createResponderMarkerIcon()
    }).addTo(map);

    const popupHtml = `
      <div style="padding: 10px 12px; font-family: Inter, sans-serif;">
        <strong style="color: #2563eb; font-size: 0.9rem;">📍 ${r.name}</strong>
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 4px;">Role: ${r.type}</div>
        <div style="font-size: 0.78rem; color: #0f172a; margin-top: 2px;">Contact: <strong>${r.contact}</strong></div>
        <div style="font-size: 0.72rem; color: #94a3b8; margin-top: 4px;">Coordinates: ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}</div>
      </div>
    `;
    marker.bindPopup(popupHtml);
    responderMarkers.set(r.id, marker);
  }
}

// ==========================================================================
// 5. SIDEBAR RENDERING: ALERTS & NODES
// ==========================================================================
function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Just now';
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diffSec = Math.floor((Date.now() - time) / 1000);

  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

// Render Alerts List
function renderAlerts() {
  const container = document.getElementById('alerts-list');
  const countBadge = document.getElementById('alerts-count-badge');
  const emptyState = document.getElementById('alerts-empty-state');

  const unacknowledgedCount = state.alerts.filter(a => !a.acknowledged).length;

  if (unacknowledgedCount > 0) {
    countBadge.textContent = unacknowledgedCount;
    countBadge.classList.remove('hidden');
    countBadge.classList.add('alert-count-active');
  } else {
    countBadge.classList.add('hidden');
    countBadge.classList.remove('alert-count-active');
  }

  if (state.alerts.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  container.innerHTML = state.alerts.map(alert => {
    const isAck = Boolean(alert.acknowledged);
    const ackClass = isAck ? 'acknowledged' : '';
    const responderText = alert.nearestResponder
      ? `<strong>${alert.nearestResponder.name}</strong> (${alert.nearestResponder.distanceKm} km)`
      : 'Tadoba Central HQ';

    const ackButtonHtml = isAck
      ? `<span class="btn-ack acked">✓ Acknowledged</span>`
      : `<button class="btn-ack" onclick="acknowledgeAlert(${alert.id})">Acknowledge</button>`;

    let statusBadgeHtml = '';
    if (alert.status === 'FIRE') {
      statusBadgeHtml = `<span class="alert-status-badge">🔥 FIRE</span>`;
    } else if (alert.status === 'WARNING') {
      statusBadgeHtml = `<span class="alert-status-badge">⚠️ WARNING</span>`;
    } else if (alert.status === 'SENSOR_FAULT') {
      statusBadgeHtml = `<span class="alert-status-badge badge-sensor-fault">⚡ Sensor fault</span>`;
    } else {
      statusBadgeHtml = `<span class="alert-status-badge">${alert.status}</span>`;
    }

    const satBadgeHtml = alert.status === 'SENSOR_FAULT' ? '' : (alert.satelliteConfirmed
      ? `<span class="badge-satellite confirmed" title="${alert.distance != null ? `Satellite hotspot ${alert.distance} km away` : 'Satellite confirmed'}">Satellite confirmed</span>`
      : `<span class="badge-satellite awaiting" title="Awaiting satellite confirmation">Awaiting satellite</span>`);

    const protocolText = alert.suggestedAction || (alert.status === 'SENSOR_FAULT'
      ? 'Inspect and recalibrate sensor hardware in field.'
      : 'Deploy patrol team to verify.');

    return `
      <div class="alert-card status-${alert.status} ${ackClass}" id="alert-card-${alert.id}">
        <div class="alert-card-top">
          <div class="alert-badges-group">
            ${statusBadgeHtml}
            ${satBadgeHtml}
          </div>
          <span class="alert-time">${formatTimeAgo(alert.time)}</span>
        </div>

        <div class="alert-node-header">
          <span class="alert-node-id">${alert.nodeId}</span>
        </div>

        <div class="alert-responder-info">
          <span>📍 Nearest: ${responderText}</span>
        </div>

        <div class="alert-action-box">
          <strong>Protocol:</strong> ${protocolText}
        </div>

        ${alert.spreadEstimate ? `
        <div class="alert-spread-info" style="margin-top: 6px; padding: 6px 8px; background: rgba(220, 38, 38, 0.08); border-left: 3px solid #dc2626; border-radius: 4px; font-size: 0.74rem; color: #991b1b; line-height: 1.35;">
          <strong>💨 Spread Forecast:</strong> ${alert.spreadEstimate} <span style="font-size: 0.68rem; opacity: 0.8;">(Simulated)</span>
        </div>` : ''}

        <div class="alert-card-footer">
          ${ackButtonHtml}
          <button class="btn-locate" onclick="focusNodeCoords(${alert.lat}, ${alert.lng}, '${alert.nodeId}')">
            Locate Node →
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Render Nodes Feed
function renderNodesList() {
  const container = document.getElementById('nodes-list');
  const countBadge = document.getElementById('nodes-count-badge');
  const nodesArray = Array.from(state.nodes.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  countBadge.textContent = nodesArray.length;

  container.innerHTML = nodesArray.map(node => {
    const isOffline = node.status === 'OFFLINE';
    const badgeLabel = isOffline ? 'No signal' : node.status;
    const cardClass = isOffline ? 'node-card offline' : 'node-card';
    const flameText = node.flame ? '🔥 Detected' : 'None';
    const flameStyle = node.flame ? 'style="color:#dc2626;"' : '';

    return `
      <div class="${cardClass}" onclick="focusNode('${node.nodeId}')">
        <div class="node-card-header">
          <div class="node-title-group">
            <span class="node-dot status-${node.status}"></span>
            <span class="node-card-id">${node.nodeId}</span>
          </div>
          <span class="node-card-badge status-${node.status}">${badgeLabel}</span>
        </div>

        <div class="node-metrics-grid">
          <div class="metric-item">
            <span class="metric-label">Temp</span>
            <span class="metric-value">${node.temp != null ? node.temp + '°C' : '--'}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Humidity</span>
            <span class="metric-value">${node.humidity != null ? node.humidity + '%' : '--'}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Smoke</span>
            <span class="metric-value">${node.smoke != null ? node.smoke + '%' : '--'}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">CO2</span>
            <span class="metric-value">${node.co2 != null ? node.co2 + ' ppm' : '415 ppm'}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Wind</span>
            <span class="metric-value">${(node.windSpeed != null && node.windDir != null) ? Math.round(node.windSpeed) + ' km/h ' + degreesToCompass(node.windDir) : '15 km/h NW'}</span>
          </div>
        </div>

        <div class="node-card-footer">
          <span>Flame: <strong ${flameStyle}>${flameText}</strong></span>
          <span>Seen: ${formatTimeAgo(node.lastSeen)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Update Top Bar Stat Counters
function updateCounters() {
  let onlineCount = 0;
  let offlineCount = 0;
  let warningsCount = 0;
  let firesCount = 0;
  const now = Date.now();
  const timeoutMs = 30000;

  for (const node of state.nodes.values()) {
    const isOffline = node.status === 'OFFLINE' || (!node.lastSeen || (now - node.lastSeen) > timeoutMs);
    if (isOffline) {
      offlineCount++;
    } else {
      onlineCount++;
      if (node.status === 'FIRE') firesCount++;
      else if (node.status === 'WARNING') warningsCount++;
    }
  }

  const totalNodes = state.nodes.size;
  document.getElementById('stat-nodes-online').textContent = `${onlineCount}/${totalNodes}`;
  const offlineEl = document.getElementById('stat-offline');
  if (offlineEl) offlineEl.textContent = offlineCount;
  document.getElementById('stat-warnings').textContent = warningsCount;
  document.getElementById('stat-fires').textContent = firesCount;

  // Active fire styling
  const fireBox = document.getElementById('stat-fire-box');
  if (firesCount > 0) {
    fireBox.style.animation = 'bannerFlame 1.5s infinite';
  } else {
    fireBox.style.animation = 'none';
  }
}

// ==========================================================================
// 6. EMERGENCY BANNER CONTROL
// ==========================================================================
function showEmergencyBanner(alert) {
  const banner = document.getElementById('emergency-banner');
  const bannerSub = document.getElementById('banner-sub');
  state.activeFireNode = alert;

  bannerSub.textContent = `Critical fire confirmed at ${alert.nodeId} (${alert.lat.toFixed(4)}, ${alert.lng.toFixed(4)}). Dispatching nearest responder.`;
  banner.classList.remove('hidden');
}

function dismissEmergencyBanner() {
  const banner = document.getElementById('emergency-banner');
  banner.classList.add('hidden');
}

// ==========================================================================
// 7. USER ACTIONS & NAVIGATION
// ==========================================================================
window.focusNodeCoords = function(lat, lng, nodeId) {
  map.flyTo([lat, lng], 13, { duration: 1.2 });
  const marker = nodeMarkers.get(nodeId);
  if (marker) {
    setTimeout(() => marker.openPopup(), 1200);
  }
};

window.focusNode = function(nodeId) {
  const node = state.nodes.get(nodeId);
  if (node) {
    window.focusNodeCoords(node.lat, node.lng, nodeId);
  }
};

window.acknowledgeAlert = async function(alertId) {
  try {
    const res = await fetch(`/api/alerts/${alertId}/ack`, { method: 'POST' });
    if (res.ok) {
      const alert = state.alerts.find(a => a.id === alertId);
      if (alert) {
        alert.acknowledged = true;
        renderAlerts();
      }
    }
  } catch (err) {
    console.error('Failed to acknowledge alert:', err);
  }
};

window.manualTrigger = async function(nodeId, action) {
  const node = state.nodes.get(nodeId);
  if (!node) return;

  if (action === 'KILL' || action === 'OFFLINE') {
    try {
      const res = await fetch(`/api/nodes/${nodeId}/kill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'wildhack-secret'
        }
      });
      if (res.ok) {
        console.log(`[Manual Trigger] ${nodeId} -> KILLED`);
      }
    } catch (err) {
      console.error('Manual kill error:', err);
    }
    return;
  }

  if (action === 'REVIVE') {
    try {
      await fetch(`/api/nodes/${nodeId}/revive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'wildhack-secret'
        }
      });
      console.log(`[Manual Trigger] ${nodeId} -> REVIVED`);
    } catch (err) {
      console.error('Manual revive error:', err);
    }
    action = 'NORMAL';
  }

  const isFire = action === 'FIRE';
  const payload = {
    nodeId: node.nodeId,
    name: node.name,
    lat: node.lat,
    lng: node.lng,
    temp: isFire ? 68.5 : 29.5,
    humidity: isFire ? 14.0 : 53.0,
    smoke: isFire ? 85.0 : 7.2,
    flame: isFire,
    co2: isFire ? 1800 : 420,
    windSpeed: isFire ? 18.0 : 8.0,
    windDir: 315.0
  };

  try {
    const res = await fetch('/api/readings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'wildhack-secret'
      },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      console.log(`[Manual Trigger] ${nodeId} -> ${action}`);
    }
  } catch (err) {
    console.error('Manual trigger error:', err);
  }
};

// ==========================================================================
// 8. REAL-TIME SERVER-SENT EVENTS (SSE)
// ==========================================================================
function updateLiveStatus(status) {
  const pill = document.getElementById('live-indicator');
  const text = document.getElementById('live-text');

  pill.className = `live-pill ${status}`;
  if (status === 'connected') {
    text.textContent = 'Live SSE';
  } else if (status === 'connecting') {
    text.textContent = 'Connecting';
  } else {
    text.textContent = 'Disconnected';
  }
}

function connectSSE() {
  updateLiveStatus('connecting');
  const eventSource = new EventSource('/api/stream');

  eventSource.onopen = () => {
    updateLiveStatus('connected');
  };

  eventSource.addEventListener('connected', () => {
    updateLiveStatus('connected');
  });

  // Reading event: live telemetry push
  eventSource.addEventListener('reading', (e) => {
    try {
      const data = JSON.parse(e.data);
      const prevNode = state.nodes.get(data.nodeId);
      const rawStatus = data.rawStatus || data.status;
      const isOffline = (Date.now() - data.lastSeen) > 30000;
      const effectiveStatus = isOffline ? 'OFFLINE' : rawStatus;

      const updatedNode = {
        ...(prevNode || {}),
        ...data,
        rawStatus: rawStatus,
        status: effectiveStatus
      };

      state.nodes.set(data.nodeId, updatedNode);
      updateMapNode(updatedNode);
      renderNodesList();
      updateCounters();
    } catch (err) {
      console.error('Error parsing reading event:', err);
    }
  });

  // Node status event (e.g. OFFLINE notification from server watchdog)
  eventSource.addEventListener('node_status', (e) => {
    try {
      const data = JSON.parse(e.data);
      const existing = state.nodes.get(data.nodeId);
      if (existing) {
        existing.status = data.status;
        if (data.status !== 'OFFLINE') {
          existing.rawStatus = data.status;
        }
        if (data.lastSeen != null) existing.lastSeen = data.lastSeen;
        updateMapNode(existing);
        renderNodesList();
        updateCounters();
      }
    } catch (err) {
      console.error('Error parsing node_status event:', err);
    }
  });

  // Alert event: new wildfire, risk trigger, or sensor fault
  eventSource.addEventListener('alert', (e) => {
    try {
      const alert = JSON.parse(e.data);

      // Prepend newest alert (avoid duplicate IDs)
      const existingIdx = state.alerts.findIndex(a => a.id === alert.id);
      if (existingIdx !== -1) {
        state.alerts[existingIdx] = alert;
      } else {
        state.alerts.unshift(alert);
      }
      renderAlerts();

      if (alert.status === 'FIRE') {
        showEmergencyBanner(alert);
        playFireAlarmSound();
        map.flyTo([alert.lat, alert.lng], 13, { duration: 1.5 });

        // Open popup automatically for FIRE
        setTimeout(() => {
          const marker = nodeMarkers.get(alert.nodeId);
          if (marker) marker.openPopup();
        }, 1500);
      }
    } catch (err) {
      console.error('Error parsing alert event:', err);
    }
  });

  // Alert clear event (sensor recovery removes fault alert)
  eventSource.addEventListener('alert_clear', (e) => {
    try {
      const data = JSON.parse(e.data);
      state.alerts = state.alerts.filter(a => !(a.nodeId === data.nodeId && (!data.status || a.status === data.status)));
      renderAlerts();
    } catch (err) {
      console.error('Error parsing alert_clear event:', err);
    }
  });

  // Alert acknowledge sync
  eventSource.addEventListener('alert_ack', (e) => {
    try {
      const { id } = JSON.parse(e.data);
      const alert = state.alerts.find(a => a.id === id);
      if (alert) {
        alert.acknowledged = true;
        renderAlerts();
      }
    } catch (err) {
      console.error('Error parsing alert_ack event:', err);
    }
  });

  eventSource.onerror = () => {
    updateLiveStatus('disconnected');
    eventSource.close();
    // Auto-reconnect after 3 seconds
    setTimeout(connectSSE, 3000);
  };
}

// Periodic check (every 5 seconds) to mark nodes OFFLINE if no data for timeout period (30s)
setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const node of state.nodes.values()) {
    // If a node is already OFFLINE, never auto-resurrect it in this timer
    if (node.status === 'OFFLINE') continue;

    const isTimedOut = node.lastSeen && (now - node.lastSeen) > 30000;
    if (isTimedOut) {
      node.status = 'OFFLINE';
      updateMapNode(node);
      changed = true;
    }
  }

  if (changed) {
    renderNodesList();
  }
  updateCounters();
}, 5000);

// ==========================================================================
// 9. INITIAL DATA LOAD & EVENT BINDINGS
// ==========================================================================
async function initApp() {
  // Setup UI tabs
  const tabAlertsBtn = document.getElementById('tab-alerts-btn');
  const tabNodesBtn = document.getElementById('tab-nodes-btn');
  const tabAlerts = document.getElementById('tab-alerts');
  const tabNodes = document.getElementById('tab-nodes');

  tabAlertsBtn.addEventListener('click', () => {
    tabAlertsBtn.classList.add('active');
    tabAlertsBtn.setAttribute('aria-selected', 'true');
    tabNodesBtn.classList.remove('active');
    tabNodesBtn.setAttribute('aria-selected', 'false');

    tabAlerts.classList.remove('hidden');
    tabNodes.classList.add('hidden');
  });

  tabNodesBtn.addEventListener('click', () => {
    tabNodesBtn.classList.add('active');
    tabNodesBtn.setAttribute('aria-selected', 'true');
    tabAlertsBtn.classList.remove('active');
    tabAlertsBtn.setAttribute('aria-selected', 'false');

    tabNodes.classList.remove('hidden');
    tabAlerts.classList.add('hidden');
  });

  // Sound toggle button
  const soundBtn = document.getElementById('sound-toggle-btn');
  const soundIconOn = document.getElementById('sound-icon-on');
  const soundIconOff = document.getElementById('sound-icon-off');

  soundBtn.addEventListener('click', () => {
    initAudioContext();
    state.soundEnabled = !state.soundEnabled;
    if (state.soundEnabled) {
      soundIconOn.classList.remove('hidden');
      soundIconOff.classList.add('hidden');
      playFireAlarmSound(); // Short confirmation chime
    } else {
      soundIconOn.classList.add('hidden');
      soundIconOff.classList.remove('hidden');
    }
  });

  // Emergency banner buttons
  document.getElementById('banner-dismiss-btn').addEventListener('click', dismissEmergencyBanner);
  document.getElementById('banner-locate-btn').addEventListener('click', () => {
    if (state.activeFireNode) {
      focusNodeCoords(state.activeFireNode.lat, state.activeFireNode.lng, state.activeFireNode.nodeId);
    }
  });

  // Recenter map button
  document.getElementById('recenter-btn').addEventListener('click', () => {
    map.flyTo(TADOBA_COORDS, TADOBA_ZOOM, { duration: 1.0 });
  });

  // Unlock AudioContext on first user interaction anywhere
  document.addEventListener('click', initAudioContext, { once: true });

  // 1. Fetch Responders
  try {
    const res = await fetch('/api/responders');
    if (res.ok) {
      state.responders = await res.json();
      renderResponders(state.responders);
    }
  } catch (e) {
    console.error('Error fetching responders:', e);
  }

  // 2. Fetch Nodes
  try {
    const res = await fetch('/api/nodes');
    if (res.ok) {
      const nodes = await res.json();
      for (const n of nodes) {
        state.nodes.set(n.nodeId, n);
        updateMapNode(n);
      }
      renderNodesList();
      updateCounters();
    }
  } catch (e) {
    console.error('Error fetching nodes:', e);
  }

  // 3. Fetch Alerts
  try {
    const res = await fetch('/api/alerts');
    if (res.ok) {
      state.alerts = await res.json();
      renderAlerts();
    }
  } catch (e) {
    console.error('Error fetching alerts:', e);
  }

  // 4. Connect SSE Stream
  connectSSE();

  // 5. Fetch Satellite Hotspots & configure 10-minute refresh
  fetchAndRenderHotspots();
  setInterval(fetchAndRenderHotspots, 10 * 60 * 1000);
}

// Start application
document.addEventListener('DOMContentLoaded', initApp);
