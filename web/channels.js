mountNav('channels.html');
startLive();
let data = null;
const native = window.webkit?.messageHandlers?.native;
const PALETTE = ['#e8681a', '#7c3aed', '#12a150', '#d99a00', '#db2777', '#0891b2', '#65a30d', '#9333ea', '#ea580c', '#0d9488'];

$('scan').onclick = scan;
async function scan() {
  $('scan').disabled = true;
  $('status').textContent = 'Scanning… (takes about 10 seconds)';
  try {
    data = await api('/api/scan', { method: 'POST' });
    render();
  } catch {
    $('status').textContent = 'Scan failed. Is Wi-Fi on?';
  }
  $('scan').disabled = false;
}

if (native) {
  $('names').hidden = false;
  $('names').onclick = () => native.postMessage('requestLocation');
}

function render() {
  const { current: cur, recommendation: rec, networks, bands } = data;
  $('status').textContent = `Last scan ${new Date(data.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  ['spectrumCard', 'chanCard', 'howCard', 'netCard'].forEach(id => $(id).hidden = false);

  const neighbours = networks.filter(n => !n.self && !n.sibling);
  let html = `<p class="summary">You're on <b>channel ${cur.channel}</b> (${cur.band} GHz, ${cur.width} MHz). `;
  if (!rec) html += `I found ${neighbours.length} other networks around you.</p>`;
  else {
    html += rec.currentCount === 0 ? 'Nobody else is using that part of the spectrum.</p>'
      : `It overlaps with <b>${rec.currentCount}</b> other network${rec.currentCount === 1 ? '' : 's'} (crowding ${fmt(rec.currentScore, 1)}).</p>`;
    html += rec.better
      ? `<div class="callout good"><b>Try channel ${rec.channel}</b> (${rec.width} MHz). It overlaps with ${rec.count === 0 ? 'nothing I can see' : `${rec.count} network${rec.count === 1 ? '' : 's'}`} (crowding ${fmt(rec.score, 1)})${rec.dfs ? '. It\'s a DFS channel, so your router has to support those, and it may take a minute to come up after you switch' : ''}.</div>`
      : `<div class="callout good">Your channel is already one of the quietest options here. Changing it won't help much.</div>`;
  }
  $('summary').innerHTML = html;

  drawSpectra();
  renderChannels(bands[cur.band] || [], cur, rec);
  renderHow(rec);
  renderNetworks();
}

function drawSpectra() {
  const box = $('spectra');
  box.innerHTML = '';
  ['2.4', '5'].forEach(band => {
    const nets = data.networks.filter(n => n.band === band);
    if (!nets.length) return;
    const title = document.createElement('div');
    title.className = 'muted small'; title.style.margin = '6px 0 4px'; title.textContent = `${band} GHz`;
    const c = document.createElement('canvas'); c.className = 'spectrum';
    box.append(title, c);
    const { ctx, w, h } = setupCanvas(c);
    const lo = band === '2.4' ? 2395 : 5150, hi = band === '2.4' ? 2490 : 5850;
    const pad = 34, bot = 20, top = 8;
    const x = f => pad + (f - lo) / (hi - lo) * (w - pad - 6);
    const y = r => top + (1 - (clamp(r, -95, -30) + 95) / 65) * (h - top - bot);

    ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.lineWidth = 1; ctx.textBaseline = 'middle';
    [-90, -70, -50].forEach(v => {
      ctx.beginPath(); ctx.moveTo(pad, y(v) + .5); ctx.lineTo(w, y(v) + .5); ctx.stroke();
      ctx.fillText(`${v}`.replace('-', '−'), 2, y(v));
    });
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    const labels = band === '2.4' ? [1, 3, 5, 7, 9, 11, 13] : [36, 52, 64, 100, 116, 132, 149, 165];
    labels.forEach(ch => {
      const f = band === '2.4' ? 2407 + 5 * ch : 5000 + 5 * ch;
      if (f >= lo && f <= hi) ctx.fillText(ch, x(f), h - bot + 5);
    });
    ctx.textAlign = 'start';

    let k = 0;
    nets.sort((a, b) => (a.self ? 1 : 0) - (b.self ? 1 : 0)).forEach(n => {
      const color = n.self || n.sibling ? css('--accent') : PALETTE[k++ % PALETTE.length];
      const [a, b] = n.span, base = h - bot, peak = y(n.rssi), edge = Math.min(6, (x(b) - x(a)) / 4);
      ctx.beginPath();
      ctx.moveTo(x(a), base);
      ctx.bezierCurveTo(x(a) + edge, peak, x(a) + edge, peak, x(a) + 2 * edge, peak);
      ctx.lineTo(x(b) - 2 * edge, peak);
      ctx.bezierCurveTo(x(b) - edge, peak, x(b) - edge, peak, x(b), base);
      ctx.fillStyle = color + (n.self ? '40' : '22'); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = n.self ? 2.5 : 1.5;
      ctx.setLineDash(n.sibling ? [4, 3] : []); ctx.stroke(); ctx.setLineDash([]);
      if (n.self || n.ssid) {
        ctx.fillStyle = color; ctx.font = '600 11px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(n.self ? (n.ssid || 'You') : n.ssid, (x(a) + x(b)) / 2, peak - 3);
        ctx.textAlign = 'start'; ctx.font = '11px -apple-system, sans-serif';
      }
    });
  });
}

function renderChannels(rows, cur, rec) {
  const tb = $('chans').querySelector('tbody'); tb.innerHTML = '';
  const max = Math.max(1, ...rows.map(r => r.score));
  rows.forEach(r => {
    const isCur = cur.channel >= r.channel && cur.channel < r.channel + r.width / 5 && cur.band === data.current.band;
    const color = r.score < 0.5 ? css('--excellent') : r.score < 1.5 ? css('--fair') : css('--bad');
    const tr = document.createElement('tr');
    if (isCur) tr.className = 'mine';
    tr.innerHTML = `<td>${r.channel}${r.width > 20 ? `<span class="muted small"> (${r.width} MHz)</span>` : ''}
        ${isCur ? '<span class="tag you">you</span>' : ''}${rec?.better && rec.channel === r.channel ? '<span class="tag best">best</span>' : ''}${r.dfs ? '<span class="tag">DFS</span>' : ''}</td>
      <td><div class="bar"><div style="width:${Math.max(3, r.score / max * 100)}%;background:${color}"></div></div></td>
      <td>${r.count}</td>`;
    tb.append(tr);
  });
}

function renderHow(rec) {
  const gw = live.latest?.gateway || '192.168.1.1';
  $('how').innerHTML = `<ol style="padding-left:20px;margin:0">
      <li>Open <a href="http://${esc(gw)}" target="_blank">http://${esc(gw)}</a> and log in.</li>
      <li>Find the wireless settings for the ${rec ? rec.band : ''} GHz network. Look for <b>Channel</b>, which is often set to Auto.</li>
      <li>Set it to <b>${rec ? rec.channel : 'the quietest channel above'}</b>${rec && rec.width > 20 ? ` and keep the width at ${rec.width} MHz` : ''}, then save.</li>
      <li>Your devices will reconnect after a few seconds. Scan again to check.</li>
    </ol>
    <p class="muted small" style="margin-top:10px">If your router doesn't list that channel (some countries or ISP routers restrict them), pick the next quietest one from the table. Neighbours change too, so it's worth scanning again in a few weeks.</p>`;
}

function renderNetworks() {
  const tb = $('nets').querySelector('tbody'); tb.innerHTML = '';
  data.networks.forEach(n => {
    const q = quality(n.rssi), tr = document.createElement('tr');
    if (n.self) tr.className = 'mine';
    const name = n.ssid ? esc(n.ssid) : '<span class="muted">hidden</span>';
    const tag = n.self ? '<span class="tag you">you</span>' : n.sibling ? '<span class="tag">your router, extra name</span>' : '';
    tr.innerHTML = `<td>${name}${tag}</td><td>${n.band} GHz</td><td>${n.channel}</td><td class="hide-sm">${n.width} MHz</td>
      <td style="color:${q.color}">${fmt(n.rssi)} dBm</td>`;
    tb.append(tr);
  });
  $('namesNote').textContent = data.namesHidden
    ? `macOS hides network names unless the app has Location permission. The channel numbers don't need it.${native ? ' Use "Show network names" to grant it, then scan again.' : ''}`
    : '';
}

api('/api/scan').then(d => { if (d) { data = d; render(); } else scan(); }).catch(scan);
