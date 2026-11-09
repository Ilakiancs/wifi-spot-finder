mountNav('speed.html');
startLive();
let hours = 168, state = null, polling = null, formLoaded = false;

document.querySelectorAll('#range button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b));
  hours = +b.dataset.h;
  $('export').href = `/api/export/speed.csv?hours=${hours}`;
  load();
});

async function load() {
  state = await api(`/api/speed?hours=${hours}`);
  if (!formLoaded) {
    const s = state.settings;
    $('planDown').value = s.planDown ?? '';
    $('planUp').value = s.planUp ?? '';
    $('interval').value = String(s.interval || 0);
    formLoaded = true;
  }
  render();
  if (state.running && !polling) polling = setInterval(load, 1500);
  if (!state.running && polling) { clearInterval(polling); polling = null; }
}

$('run').onclick = async () => {
  const r = await api('/api/speed/run', { method: 'POST' });
  if (!r.ok) { $('status').textContent = 'Another test is running. Try again in a moment.'; return; }
  load();
};
$('save').onclick = async () => {
  await api('/api/speed/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planDown: $('planDown').value, planUp: $('planUp').value, interval: +$('interval').value }),
  });
  $('save').textContent = 'Saved';
  setTimeout(() => $('save').textContent = 'Save', 1500);
  formLoaded = false; load();
};
['planDown', 'planUp', 'interval'].forEach(id => $(id).addEventListener('input', usage));

function usage() {
  const last = state?.tests.at(-1), secs = state?.testSeconds || 16;
  const mb = last ? (last.mb ?? (last.down + last.up) * secs / 16) : null;
  const perDay = +$('interval').value ? 1440 / +$('interval').value : 0;
  $('usage').textContent = mb == null
    ? `Each check runs for about ${secs} seconds and downloads and uploads as fast as it can.`
    : `The last check used about ${Math.round(mb)} MB` +
      (perDay ? `, so about ${fmt(mb * perDay / 1000, 1)} GB a day at this schedule. Worth knowing if your plan has a data cap.` : '.');
}

function render() {
  const s = state.summary, set = state.settings, tests = state.tests;
  $('run').disabled = state.running;
  $('status').textContent = state.running ? `Testing… ${Math.round(Date.now() / 1000 - state.started)} s`
    : state.error ? state.error : tests.length ? `Last check ${fmtTime(tests.at(-1).t)}` : '';
  usage();

  const pct = (p) => p == null ? '' : ` · ${p}% of plan`;
  const pctColor = p => p == null ? '' : p >= 80 ? css('--excellent') : p >= 50 ? css('--fair') : css('--bad');
  const tile = (k, v, h, color) => `<div class="tile"><div class="k">${k}</div><div class="v" ${color ? `style="color:${color}"` : ''}>${v}</div><div class="h">${h}</div></div>`;
  const best = Object.entries(s.byPeriod).filter(([, v]) => v.count).sort((a, b) => a[1].avgDown - b[1].avgDown);
  $('tiles').innerHTML =
    tile('Average download', s.avgDown == null ? '--' : `${fmt(s.avgDown, 0)} Mbps`, set.planDown ? `plan ${fmt(set.planDown, 0)} Mbps${pct(s.pctDown)}` : 'set your plan above', pctColor(s.pctDown)) +
    tile('Average upload', s.avgUp == null ? '--' : `${fmt(s.avgUp, 0)} Mbps`, set.planUp ? `plan ${fmt(set.planUp, 0)} Mbps${pct(s.pctUp)}` : 'set your plan above', pctColor(s.pctUp)) +
    tile('Slowest check', s.minDown == null ? '--' : `${fmt(s.minDown, 0)} Mbps`, set.planDown ? `${s.below50} below half your plan` : 'download') +
    tile('Slowest time of day', best.length > 1 ? best[0][0] : '--', best.length > 1 ? `avg ${fmt(best[0][1].avgDown, 0)} Mbps` : 'needs checks at different times') +
    tile('Checks', s.count, s.wifiLimited ? `${s.wifiLimited} limited by Wi-Fi` : 'in this period');

  drawChart(); drawPeriods(); renderTable();
}

function drawChart() {
  const { ctx, w, h } = setupCanvas($('chart'));
  const tests = state.tests, set = state.settings, pad = 44, top = 10, bot = 22;
  const now = Date.now() / 1000, from = now - hours * 3600;
  const ymax = Math.max(10, set.planDown || 0, set.planUp || 0, ...tests.map(t => Math.max(t.down, t.up))) * 1.15;
  const x = t => pad + (t - from) / (now - from) * (w - pad - 8), y = v => top + (1 - v / ymax) * (h - top - bot);
  ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
  [0, ymax / 2, ymax].forEach(v => { ctx.beginPath(); ctx.moveTo(pad, y(v) + .5); ctx.lineTo(w, y(v) + .5); ctx.stroke(); ctx.fillText(`${Math.round(v)}`, 4, y(v)); });
  ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  const step = hours <= 168 ? 86400 : 5 * 86400;
  for (let t = Math.ceil(from / step) * step; t <= now; t += step) ctx.fillText(new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }), x(t), h - bot + 6);
  ctx.textAlign = 'start';
  [[set.planDown, css('--accent')], [set.planUp, css('--excellent')]].forEach(([v, c]) => {
    if (!v) return;
    ctx.strokeStyle = c; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(pad, y(v)); ctx.lineTo(w, y(v)); ctx.stroke(); ctx.setLineDash([]);
  });
  if (!tests.length) { ctx.textAlign = 'center'; ctx.fillText('No checks in this period', w / 2, h / 2); ctx.textAlign = 'start'; return; }
  tests.forEach(t => [[t.down, css('--accent')], [t.up, css('--excellent')]].forEach(([v, c]) => {
    ctx.beginPath(); ctx.arc(x(t.t), y(v), 4, 0, Math.PI * 2);
    if (t.wifiLimited) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); } else { ctx.fillStyle = c; ctx.fill(); }
  }));
}

function drawPeriods() {
  const { ctx, w, h } = setupCanvas($('periods'));
  const p = state.summary.byPeriod, plan = state.settings.planDown, names = Object.keys(p);
  const ymax = Math.max(10, plan || 0, ...names.map(n => p[n].avgDown || 0)) * 1.15, bot = 22, top = 8;
  const bw = (w - 20) / names.length;
  ctx.textAlign = 'center';
  names.forEach((n, i) => {
    const v = p[n].avgDown, cx = 10 + bw * i + bw / 2, bh = v ? v / ymax * (h - top - bot) : 0;
    ctx.fillStyle = v == null ? css('--track') : !plan ? css('--accent') : v >= 0.8 * plan ? css('--excellent') : v >= 0.5 * plan ? css('--fair') : css('--bad');
    ctx.beginPath(); ctx.roundRect(cx - bw * 0.3, h - bot - Math.max(bh, 2), bw * 0.6, Math.max(bh, 2), 4); ctx.fill();
    ctx.fillStyle = css('--muted'); ctx.textBaseline = 'top'; ctx.fillText(n, cx, h - bot + 6);
    if (v != null) { ctx.fillStyle = css('--ink'); ctx.textBaseline = 'bottom'; ctx.fillText(`${Math.round(v)}`, cx, h - bot - bh - 3); }
  });
  ctx.textAlign = 'start';
  if (plan) {
    const py = top + (1 - plan / ymax) * (h - top - bot);
    ctx.strokeStyle = css('--muted'); ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke(); ctx.setLineDash([]);
  }
}

function renderTable() {
  const tb = $('tests').querySelector('tbody'); tb.innerHTML = '';
  const tests = [...state.tests].reverse();
  $('tests').hidden = !tests.length; $('noTests').hidden = !!tests.length;
  const plan = state.settings.planDown;
  tests.forEach(t => {
    const tr = document.createElement('tr');
    const pc = plan ? ` <span class="muted small">(${Math.round(100 * t.down / plan)}%)</span>` : '';
    tr.innerHTML = `<td>${fmtTime(t.t)}${t.reason === 'scheduled' ? ' <span class="muted small">auto</span>' : ''}</td>
      <td>${fmt(t.down, 0)} Mbps${pc}</td><td>${fmt(t.up, 0)} Mbps</td>
      <td class="hide-sm">${t.latency == null ? '--' : fmt(t.latency, 0) + ' ms'}</td>
      <td class="hide-sm" style="color:${quality(t.rssi).color}">${t.rssi ? fmt(t.rssi) + ' dBm' : '--'}</td>
      <td>${t.wifiLimited ? '<span class="flag">limited by Wi-Fi</span>' : ''}</td>`;
    tb.append(tr);
  });
}

window.addEventListener('resize', () => state && render());
load();
