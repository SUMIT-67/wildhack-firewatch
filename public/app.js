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
const responderMarkers = new Map();  // Map<responderId, L.Marker>
const hotspotLayer = L.layerGroup().addTo(map); // Satellite layer (on by default)

// Layer toggle control for Satellite Hotspots
L.control.layers(null, { 'Satellite hotspots': hotspotLayer }, {
  position: 'topright',
  collapsed: false
}).addTo(map);

// Create Custom Node Marker HTML
function createNodeMarkerIcon(node) {
  const shortCode = node.nodeId.replace('NODE-', '');
  const statusClass = `status-${node.status}`;

  const html = `
    <div class="node-marker-bubble ${statusClass}" title="${node.nodeId}: ${node.status}">
      ${shortCode}
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
  const gmapsDirUrl = `https://www.google.com/maps/dir/?api=1&destination=${node.lat},${node.lng}`;
  const flameText = node.flame ? 'YES 🔥' : 'None';
  const flameClass = node.flame ? 'style="color:#dc2626; font-weight:700;"' : '';
  const lastSeenStr = formatTimeAgo(node.lastSeen);

  return `
    <div class="popup-container">
      <div class="popup-header">
        <div class="popup-title">${node.nodeId}</div>
        <span class="popup-badge status-${node.status}">${node.status}</span>
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

    const satBadgeHtml = alert.satelliteConfirmed
      ? `<span class="badge-satellite confirmed" title="${alert.distance != null ? `Satellite hotspot ${alert.distance} km away` : 'Satellite confirmed'}">Satellite confirmed</span>`
      : `<span class="badge-satellite awaiting" title="Awaiting satellite confirmation">Awaiting satellite</span>`;

    return `
      <div class="alert-card status-${alert.status} ${ackClass}" id="alert-card-${alert.id}">
        <div class="alert-card-top">
          <div class="alert-badges-group">
            <span class="alert-status-badge">
              ${alert.status === 'FIRE' ? '🔥' : '⚠️'} ${alert.status}
            </span>
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
          <strong>Protocol:</strong> ${alert.suggestedAction || 'Deploy patrol team to verify.'}
        </div>

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
    const flameText = node.flame ? '🔥 Detected' : 'None';
    const flameStyle = node.flame ? 'style="color:#dc2626;"' : '';

    return `
      <div class="node-card" onclick="focusNode('${node.nodeId}')">
        <div class="node-card-header">
          <div class="node-title-group">
            <span class="node-dot status-${node.status}"></span>
            <span class="node-card-id">${node.nodeId}</span>
          </div>
          <span class="node-card-badge status-${node.status}">${node.status}</span>
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
  let warningsCount = 0;
  let firesCount = 0;
  const now = Date.now();

  for (const node of state.nodes.values()) {
    const isOnline = (now - node.lastSeen) <= 60000;
    if (isOnline) {
      onlineCount++;
      if (node.status === 'FIRE') firesCount++;
      else if (node.status === 'WARNING') warningsCount++;
    }
  }

  const totalNodes = state.nodes.size;
  document.getElementById('stat-nodes-online').textContent = `${onlineCount}/${totalNodes}`;
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
      const isOffline = (Date.now() - data.lastSeen) > 60000;
      const effectiveStatus = isOffline ? 'OFFLINE' : data.status;

      const updatedNode = {
        ...(prevNode || {}),
        ...data,
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

  // Alert event: new wildfire or risk trigger
  eventSource.addEventListener('alert', (e) => {
    try {
      const alert = JSON.parse(e.data);

      // Prepend newest alert
      state.alerts.unshift(alert);
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

// Periodic check (every 5 seconds) to mark nodes OFFLINE if no data for 60s
setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const node of state.nodes.values()) {
    const isOffline = (now - node.lastSeen) > 60000;
    const targetStatus = isOffline ? 'OFFLINE' : (node.rawStatus || node.status);

    if (node.status !== targetStatus) {
      node.status = targetStatus;
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
