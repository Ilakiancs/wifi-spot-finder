mountNav('history.html');
startLive();
let hours = 24, data = null;

document.querySelectorAll('#range button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b));
  hours = +b.dataset.h; load();
});

async function load() {
  data = await api(`/api/history?hours=${hours}`);
  $('expOut').href = `/api/export/outages.csv?hours=${hours}`;
  $('expAll').href = `/api/export/samples.csv?hours=${hours}`;
  render();
}

function render() {
  const s = data.summary, span = data.to - data.from;
  const q = quality(s.avgRssi);
  const tile = (k, v, h, color) => `<div class="tile"><div class="k">${k}</div><div class="v" ${color ? `style="color:${color}"` : ''}>${v}</div><div class="h">${h}</div></div>`;
  $('tiles').innerHTML =
    tile('Average signal', s.avgRssi == null ? '--' : `${fmt(s.avgRssi, 0)} dBm`, s.avgRssi == null ? 'no data yet' : q.name, s.avgRssi == null ? '' : q.color) +
    tile('Time with weak signal', s.weakPct == null ? '--' : `${s.weakPct}%`, 'below −72 dBm') +
    tile('Dropouts', s.dropouts, Object.entries(s.byKind).map(([k, n]) => `${n} ${k}`).join(' · ') || 'none', s.dropouts ? css('--bad') : css('--excellent')) +
    tile('Total downtime', fmtDuration(s.downtime), 'sum of all dropouts') +
    tile('Internet ping', s.avgInternet == null ? '--' : `${fmt(s.avgInternet, 0)} ms`, 'average') +
    tile('Internet packet loss', s.internetLoss == null ? '--' : `${fmt(s.internetLoss, 1)}%`, 'average');
  const pct = Math.min(100, Math.round(100 * s.monitoredSecs / span));
  $('coverage').innerHTML = `Monitored <b>${fmtDuration(s.monitoredSecs)}</b> of this period (${pct}%). Logging only happens while the app is running. For round-the-clock evidence, turn on <b>Launch at Login</b> from the Wi‑Fi icon in your menu bar.`;
  drawCharts(); renderEvents();
}

function timeAxis(ctx, w, h, x, pad, bot) {
  const span = data.to - data.from, step = span < 2 * 86400 ? 3 * 3600 : span < 10 * 86400 ? 86400 : 5 * 86400;
  ctx.fillStyle = css('--muted'); ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  const first = Math.ceil(data.from / step) * step;
  for (let t = first; t <= data.to; t += step) {
    const d = new Date(t * 1000);
    const label = step < 86400 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    ctx.fillText(label, x(t), h - bot + 6);
  }
  ctx.textAlign = 'start';
}
function shadeEvents(ctx, x, top, height) {
  ctx.fillStyle = 'rgba(217,54,54,.22)';
  data.events.forEach(e => ctx.fillRect(x(e.start), top, Math.max(2, x(e.end) - x(e.start)), height));
}
function line(ctx, pts, x, y, color, width, colorFn) {
  ctx.lineWidth = width; ctx.lineJoin = 'round';
  for (let k = 1; k < pts.length; k++) {
    const [ta, va] = pts[k - 1], [tb, vb] = pts[k];
    if (va == null || vb == null || tb - ta > 120) continue;  // gap: app wasn't running
    ctx.strokeStyle = colorFn ? colorFn(vb) : color;
    ctx.beginPath(); ctx.moveTo(x(ta), y(va)); ctx.lineTo(x(tb), y(vb)); ctx.stroke();
  }
}

function drawCharts() {
  const S = data.samples, pad = 40, top = 8, bot = 22;
  { const { ctx, w, h } = setupCanvas($('sig'));
    const x = t => pad + (t - data.from) / (data.to - data.from) * (w - pad - 6);
    const lo = -95, hi = -40, y = v => top + (1 - (clamp(v, lo, hi) - lo) / (hi - lo)) * (h - top - bot);
    shadeEvents(ctx, x, top, h - top - bot);
    ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
    [[-55, '--excellent'], [-65, '--good'], [-72, '--fair'], [-80, '--weak']].forEach(([v, c]) => {
      ctx.strokeStyle = css('--line'); ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(pad, y(v)); ctx.lineTo(w, y(v)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css(c); ctx.fillText(`${v}`.replace('-', '−'), 2, y(v));
    });
    line(ctx, S.map(s => [s.t, s.rssi]), x, y, null, 2, v => quality(v).color);
    timeAxis(ctx, w, h, x, pad, bot);
    if (!S.length) { ctx.fillStyle = css('--muted'); ctx.textAlign = 'center'; ctx.fillText('No data yet. Logging starts as soon as the app is running.', w / 2, h / 2); ctx.textAlign = 'start'; }
  }
  { const { ctx, w, h } = setupCanvas($('net'));
    const x = t => pad + (t - data.from) / (data.to - data.from) * (w - pad - 6);
    const vals = S.flatMap(s => [s.i, s.r]).filter(v => v != null).sort((a, b) => a - b);
    const ymax = Math.max(30, (vals[Math.floor(vals.length * 0.98)] || 30) * 1.2);
    const y = v => top + (1 - clamp(v, 0, ymax) / ymax) * (h - top - bot);
    shadeEvents(ctx, x, top, h - top - bot);
    ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
    [0, ymax / 2, ymax].forEach(v => { ctx.beginPath(); ctx.moveTo(pad, y(v) + .5); ctx.lineTo(w, y(v) + .5); ctx.stroke(); ctx.fillText(`${Math.round(v)} ms`, 2, y(v)); });
    line(ctx, S.map(s => [s.t, s.r]), x, y, css('--muted'), 1.5);
    line(ctx, S.map(s => [s.t, s.i]), x, y, css('--accent'), 2);
    timeAxis(ctx, w, h, x, pad, bot);
  }
}

function renderEvents() {
  const tb = $('events').querySelector('tbody'); tb.innerHTML = '';
  const ev = [...data.events].reverse();
  $('events').hidden = !ev.length; $('noEvents').hidden = !!ev.length;
  ev.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtTime(e.start)}</td><td>${fmtDuration(e.duration)}${e.ongoing ? ' <span class="badge" style="background:var(--bad)">NOW</span>' : ''}</td>
      <td class="kind ${e.kind}">${STATE_LABEL[e.kind] || e.kind}</td>`;
    tb.append(tr);
  });
}
window.addEventListener('resize', () => data && drawCharts());
load();
setInterval(load, 30000);
