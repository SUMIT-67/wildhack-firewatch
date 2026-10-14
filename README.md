# WildHack FireWatch 🌲🔥
### Forest Fire Early Detection & Response System
**Deployment Site:** Tadoba Andhari Tiger Reserve (TATR), Maharashtra, India

WildHack FireWatch is a real-time IoT wildfire detection, risk prediction, and rapid emergency dispatch system built specifically for the core and buffer zones of Tadoba Andhari Tiger Reserve. It continuously ingests sensor telemetry, performs real-time fire and risk classification, calculates the nearest ranger post using the Haversine formula, streams updates via Server-Sent Events (SSE), and coordinates field teams with instant Telegram alerts and Google Maps navigation.

---

## Architecture & Features

- **Backend**: Node.js 20 + Express.
- **Database**: SQLite with WAL mode via `better-sqlite3` (single-file database, zero external dependencies).
- **Realtime Telemetry**: Server-Sent Events (SSE) at `GET /api/stream` with automatic reconnects and heartbeat.
- **Frontend Dashboard**:
  - Single static page in `/public` (`index.html`, `style.css`, `app.js`).
  - No build step, no framework.
  - Interactive Leaflet map centered on Tadoba (`lat 20.25, lng 79.35`, zoom 11) using real OpenStreetMap tiles.
  - Live color-coded nodes: Green (`NORMAL`), Warm Amber (`WARNING`), Crimson Pulsing (`FIRE`), Slate Grey (`OFFLINE` if no data for > 60s).
  - Blue markers for Tadoba Ranger Stations / Watchtowers.
  - Interactive popups with live sensor metrics, Google Maps navigation links, and dynamic telemetry sparkline charts (Chart.js via CDN).
  - Right sidebar with active alert cards (including nearest responder distance and action protocol), acknowledge buttons, and a live node list.
  - Audio and visual alarm: Top red banner + Web Audio synthesizer alarm beep when a fire is detected.
- **Automated Dispatch**:
  - Automatically computes the closest ranger post and distance (in km) for every node.
  - Telegram Bot alerts sent directly to forest officers and quick response teams.
- **Software Simulator**:
  - Interactive CLI simulator in `/simulator/simulate.js`.
  - Transmits realistic sensor telemetry for 4 Tadoba nodes every 5 seconds.
  - Supports live CLI triggers (`fire A`, `warn B`, `clear`, `status`).

---

## Quick Start (Local Run)

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```
The server will start at `http://localhost:3000`. Open your browser to view the live dashboard!

### 3. Run the Sensor Simulator
In a separate terminal window:
```bash
npm run simulate
```
You can now test live alerts interactively by typing:
- `fire A` — Simulates a fire on Node A (flame detected, 64°C, 85% smoke).
- `warn B` — Simulates a high-risk warning on Node B.
- `clear`  — Resets all nodes back to normal baseline.
- `status` — Displays current node states.

---

## Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the Express HTTP and SSE server |
| `API_KEY` | `wildhack-secret` | Secret key expected in the `x-api-key` header for sensor ingestion |
| `TELEGRAM_BOT_TOKEN` | *(optional)* | Telegram Bot token for sending wildfire alerts |
| `TELEGRAM_CHAT_ID` | *(optional)* | Telegram Chat/Group ID where alerts are delivered |
| `SERVER_URL` | `http://localhost:3000` | Base URL used by the simulator |

---

## Sensor Ingestion: `curl` Example

Sensor nodes post readings to `/api/readings` with the `x-api-key` header:

```bash
curl -X POST http://localhost:3000/api/readings \
  -H "Content-Type: application/json" \
  -H "x-api-key: wildhack-secret" \
  -d '{
    "nodeId": "NODE-A",
    "lat": 20.2215,
    "lng": 79.3320,
    "temp": 64.5,
    "humidity": 18.2,
    "smoke": 82.0,
    "flame": true
  }'
```

### Response:
```json
{
  "status": "FIRE",
  "score": 90
}
```

### Risk & Status Classification Logic
1. **FIRE**:
   - Triggered when `flame == true` OR (`smoke > 60` AND `temp > 50`).
2. **WARNING**:
   - Triggered when cumulative risk score $\ge 40$, calculated as:
     - Temperature: `temp > 45` $\rightarrow$ `+30`, else `temp > 38` $\rightarrow$ `+15`
     - Humidity: `humidity < 30` $\rightarrow$ `+20`, else `humidity < 40` $\rightarrow$ `+10`
     - Smoke: `smoke > 40` $\rightarrow$ `+30`, else `smoke > 25` $\rightarrow$ `+15`
3. **NORMAL**:
   - All other nominal readings.
4. **OFFLINE**:
   - Automatically displayed for any node that has not transmitted a reading for 60 seconds.

---

## REST & SSE API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/readings` | Ingest IoT sensor reading (`x-api-key` required) |
| `GET` | `/api/nodes` | List all nodes, latest state, and offline status |
| `GET` | `/api/alerts` | List the last 50 alerts (newest first) |
| `GET` | `/api/history/:nodeId`| Fetch the last 60 readings for chart visualization |
| `GET` | `/api/responders` | List Tadoba ranger stations & watchtowers |
| `GET` | `/api/stream` | Server-Sent Events (SSE) stream (`reading`, `alert`, `alert_ack`) |
| `POST` | `/api/alerts/:id/ack` | Mark an alert acknowledged |
| `GET` | `/health` | Health check endpoint (`{ ok: true }`) |

---

## Tadoba Responder Locations (Demo Seed)

| Responder Station | Coordinates | Zone | Contact |
| :--- | :--- | :--- | :--- |
| Moharli Forest Station & Watchtower | 20.1872, 79.3142 | Southern Core | +91 7172 251 201 |
| Kolara Quick Response Camp | 20.3621, 79.3875 | Northern Gate | +91 7172 251 202 |
| Navegaon Range Outpost | 20.3210, 79.4310 | Eastern Buffer | +91 7172 251 203 |
| Tadoba Lake Watchtower HQ | 20.2450, 79.3490 | Central Core | +91 7172 251 204 |

---

## Deployment to Render

This project includes a native `render.yaml` specification for zero-config one-click deployment:

1. **Push this repository** to GitHub or GitLab.
2. Log in to [Render.com](https://render.com) and click **New +** $\rightarrow$ **Blueprint**.
3. Select this repository. Render will automatically read `render.yaml` and configure:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
4. *(Optional)* Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` under the service environment variables for Telegram notifications.
5. Click **Apply**. Your app is live in seconds with HTTPS enabled!
