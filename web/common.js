// Shared helpers for all Wi-Fi Spot Finder pages.
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const fmt = (v, d = 0) => v == null ? '--' : Number(v).toFixed(d).replace('-', '−');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LOGO_SVG = `<svg class="logo" viewBox="100 100 824 824" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="lg" x1="0.35" y1="0" x2="0.65" y2="1">
    <stop offset="0" stop-color="#10bacc"/><stop offset=".5" stop-color="#2961f2"/><stop offset="1" stop-color="#33299e"/></linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#lg)"/>
  <g fill="none" stroke="#fff" stroke-width="62" stroke-linecap="round">
    <path d="M395.3 477.3A165 165 0 0 1 628.7 477.3"/>
    <path d="M324.6 406.6A265 265 0 0 1 699.4 406.6" stroke-opacity=".85"/>
    <path d="M253.9 335.9A365 365 0 0 1 770.1 335.9" stroke-opacity=".65"/>
  </g>
  <path d="M512 774L441.7 627.8A78 78 0 1 1 582.3 627.8Z" fill="#fff"/>
  <circle cx="512" cy="594" r="34" fill="#ff9e33"/>
</svg>`;

const PAGES = [['index.html', 'Live'], ['heatmap.html', 'Heatmap'], ['channels.html', 'Channels'], ['lag.html', 'Lag test'], ['speed.html', 'Speed'], ['history.html', 'History']];

function mountNav(active) {
  $('nav').innerHTML = `<a class="brand" href="index.html">${LOGO_SVG}<span>Wi‑Fi Spot Finder</span></a>
    <nav class="tabs">${PAGES.map(([h, l]) => `<a href="${h}" class="${h === active ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <span class="pill"><span class="dot" id="dot"></span><span id="conn">Connecting…</span></span>`;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(LOGO_SVG);
  document.head.append(link);
}

function quality(r) {
  if (r == null || r === 0) return { name: 'No signal', color: css('--bad'), key: 'bad' };
  if (r >= -55) return { name: 'Excellent', color: css('--excellent'), key: 'excellent' };
  if (r >= -65) return { name: 'Good', color: css('--good'), key: 'good' };
  if (r >= -72) return { name: 'Fair', color: css('--fair'), key: 'fair' };
  if (r >= -80) return { name: 'Weak', color: css('--weak'), key: 'weak' };
  return { name: 'Very weak', color: css('--bad'), key: 'bad' };
}

// 0–100 score for a recorded spot: signal 70%, router ping 20%, stability 10%
function spotScore(s) {
  const sig = clamp((s.rssi + 90) / 40, 0, 1);
  const lat = s.ping == null ? 0 : clamp(1 - (s.ping - 2) / 48, 0, 1);
  const stab = clamp(1 - (s.loss || 0) / 10, 0, 1) * clamp(1 - (s.jitter || 0) / 30, 0, 1);
  return Math.round(100 * (0.7 * sig + 0.2 * lat + 0.1 * stab));
}

function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h < 24 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
const fmtTime = t => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const STATE_LABEL = { wifi: 'Wi‑Fi disconnected', router: 'Router unreachable', internet: 'Internet down (ISP side)' };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
}

// ---- live stream: one EventSource shared by page code; also keeps the header pill updated
const live = { latest: null, listeners: [] };
function startLive(onSample) {
  if (onSample) live.listeners.push(onSample);
  if (live.es) return;
  live.es = new EventSource('/events');
  live.es.onopen = () => $('dot')?.classList.add('live');
  live.es.onerror = () => {
    $('dot')?.classList.remove('live');
    if ($('conn')) $('conn').textContent = 'Disconnected, is the app running?';
  };
  live.es.onmessage = e => {
    const d = JSON.parse(e.data);
    live.latest = d;
    const connected = d.on && d.rssi;
    if ($('conn')) {
      let t = connected ? `${d.band} GHz · ch ${d.channel} · ${fmt(d.rssi)} dBm` : (d.on === false ? 'Wi‑Fi is off' : 'Not connected');
      if (d.state && STATE_LABEL[d.state]) t = `⚠ ${STATE_LABEL[d.state]}`;
      $('conn').textContent = t;
    }
    live.listeners.forEach(fn => fn(d, connected));
  };
}

// ---- spot recording, shared by Live and Heatmap pages
function recordSpot({ name, ms = 10000, x, y, onProgress, onDone }) {
  const samples = [], start = Date.now();
  const fn = (d, connected) => {
    if (connected) samples.push(d);
    const p = (Date.now() - start) / ms;
    onProgress?.(clamp(p, 0, 1));
    if (p < 1) return;
    live.listeners = live.listeners.filter(f => f !== fn);
    if (samples.length < 4) return onDone(null);
    const ok = samples.map(s => s.ping).filter(v => v != null);
    const spot = {
      name, at: new Date().toISOString(),
      rssi: Math.round(avg(samples.map(s => s.rssi)) * 10) / 10,
      min: Math.min(...samples.map(s => s.rssi)), max: Math.max(...samples.map(s => s.rssi)),
      ping: ok.length ? Math.round(avg(ok) * 10) / 10 : null,
      jitter: samples.at(-1).jitter, loss: samples.at(-1).loss,
      tx: Math.round(avg(samples.map(s => s.tx))),
    };
    if (x != null) { spot.x = x; spot.y = y; }
    spot.score = spotScore(spot);
    onDone(spot);
  };
  startLive();
  live.listeners.push(fn);
}

const loadSpots = () => api('/api/spots').catch(() => []);
const saveSpots = spots => api('/api/spots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spots) }).catch(() => {});

// ---- canvas helper (crisp on retina, sized by CSS)
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px -apple-system, sans-serif';
  return { ctx, w, h };
}
