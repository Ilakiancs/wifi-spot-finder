mountNav('lag.html');
startLive();
const EXPECTED = 55;
let state = null, polling = null;

const GRADE_COLOR = g => ({ 'A+': '--excellent', A: '--excellent', B: '--good', C: '--fair', D: '--weak', F: '--bad' }[g] || '--muted');
const VERDICT = {
  'A+': ['Excellent: no lag under load', 'Calls, gaming and screen sharing stay smooth even while the connection is maxed out.'],
  A: ['Great: barely any lag under load', 'Busy moments add only a little delay. You won\'t notice it on calls or in games.'],
  B: ['Good: slight lag under load', 'Heavy downloads or uploads add some delay. Most calls are fine, but competitive games may feel it.'],
  C: ['Noticeable lag when the connection is busy', 'Video calls can stutter and games spike while something uploads or downloads (backups, cloud sync, updates).'],
  D: ['Bad lag under load', 'Whenever the connection is busy, everything feels slow: calls freeze, pages hang, games are unplayable.'],
  F: ['Severe lag under load', 'Delay grows to whole seconds while the connection is busy. Calls drop or freeze, and this is very fixable with router QoS (below).'],
};

async function refresh() {
  state = await api('/api/lagtest');
  render();
  if (state.running && !polling) polling = setInterval(refresh, 600);
  if (!state.running && polling) { clearInterval(polling); polling = null; }
}
$('start').onclick = async () => {
  await api('/api/lagtest', { method: 'POST' });
  state = null; refresh();
};

function render() {
  const s = state, res = s.result || (!s.running && s.history.length ? s.history.at(-1) : null);
  $('start').disabled = s.running;
  $('prog').style.visibility = s.running ? 'visible' : 'hidden';
  if (s.running) {
    const label = { idle: 'Measuring idle baseline…', load: 'Loading the connection (download, then upload)…', analyze: 'Crunching numbers…' }[s.phase] || 'Starting…';
    $('status').textContent = `${label} ${Math.round(s.elapsed || 0)} s`;
    $('prog').firstElementChild.style.width = `${clamp((s.elapsed || 0) / EXPECTED, 0, 0.97) * 100}%`;
    $('grade').className = 'grade pending'; $('grade').textContent = '…'; $('grade').style.background = '';
  } else {
    $('status').textContent = s.error ? `⚠ ${s.error}` : res ? `Last run ${fmtTime(res.at)}` : '';
  }
  drawChart(s.running ? s.pings : s.result?.pings, s.running ? null : s.result?.phases);
  if (!s.running && res) showResult(res);
  renderHistory(s.history);
}

const sources = (p, a) => [p != null ? `ping +${fmt(p, 0)}` : null, a != null ? `Apple +${fmt(a, 0)}` : null].filter(Boolean).join(', ') || 'no data';

function showResult(r) {
  document.querySelectorAll('#resultCard p').forEach(p => p.remove());
  const g = $('grade');
  g.className = 'grade'; g.textContent = r.grade || '?'; g.style.background = css(GRADE_COLOR(r.grade));
  const [title, text] = VERDICT[r.grade] || ['Result', ''];
  $('vTitle').textContent = title; $('vText').textContent = text;
  $('start').textContent = 'Run again';

  const tile = (k, v, h, color) => `<div class="tile"><div class="k">${k}</div><div class="v" ${color ? `style="color:${css(color)}"` : ''}>${v}</div><div class="h">${h}</div></div>`;
  $('resultCard').hidden = false;
  $('tiles').innerHTML =
    tile('Download speed', `${fmt(r.down, 0)} Mbps`, 'measured by Apple') +
    tile('Upload speed', `${fmt(r.up, 0)} Mbps`, 'measured by Apple') +
    tile('Idle ping', r.idle == null ? '--' : `${fmt(r.idle, 0)} ms`, `to ${r.target || '1.1.1.1'} when quiet`) +
    tile('Lag added while downloading', r.dlAdded == null ? '--' : `+${fmt(r.dlAdded, 0)} ms`, `grade ${r.gradeDown ?? '--'} · ${sources(r.dlAddedPing, r.dlAddedApple)}${r.dlLoss ? ` · ${r.dlLoss}% pings lost` : ''}`, GRADE_COLOR(r.gradeDown)) +
    tile('Lag added while uploading', r.ulAdded == null ? '--' : `+${fmt(r.ulAdded, 0)} ms`, `grade ${r.gradeUp ?? '--'} · ${sources(r.ulAddedPing, r.ulAddedApple)}${r.ulLoss ? ` · ${r.ulLoss}% pings lost` : ''}`, GRADE_COLOR(r.gradeUp));
  $('tiles').insertAdjacentHTML('afterend', `<p class="muted small" style="margin-top:10px">Lag is measured two ways: our ping to ${esc(r.target || '1.1.1.1')} (the chart above), and Apple's probes on separate connections while the line is busy. Those probes behave like a video call. The grade uses whichever is worse. Many networks let ping skip the queue, so Apple's number is usually the honest one.</p>`);

  const bad = ['B', 'C', 'D', 'F'].includes(r.grade);
  $('fixCard').hidden = !bad;
  if (!bad) return;
  const d90 = Math.floor(r.down * 0.9), u90 = Math.floor(r.up * 0.9), d80 = Math.floor(r.down * 0.8), u80 = Math.floor(r.up * 0.8);
  const gw = state.gateway || '192.168.1.1';
  const worse = (r.ulAdded || 0) > (r.dlAdded || 0) ? 'uploads' : 'downloads';
  $('fix').innerHTML = `
    <p>The lag happens because your router (or the modem) lets a huge queue of data build up when the line is full, so everything else waits behind it. Most of yours comes from <b>${worse}</b>. Capping speeds a little below the maximum keeps the queue on the router side, where QoS can keep it short.</p>
    <div class="qos">
      <div class="tile"><div class="k">Download limit</div><div class="v">${d90} Mbps</div><div class="h">90% of ${fmt(r.down, 0)} Mbps</div></div>
      <div class="tile"><div class="k">Upload limit</div><div class="v">${u90} Mbps</div><div class="h">90% of ${fmt(r.up, 0)} Mbps</div></div>
    </div>
    <ol>
      <li>Open <a href="http://${esc(gw)}" target="_blank">http://${esc(gw)}</a> and log in. The password is often on a sticker on the router.</li>
      <li>Look for <b>QoS</b>, <b>Smart QoS</b>, <b>SQM</b>, <b>Bandwidth control</b> or <b>Traffic shaping</b>. It's usually under Advanced settings.</li>
      <li>Turn it on and enter the download and upload limits above. If it asks for kbps, multiply by 1000.</li>
      <li>If it offers <b>SQM with "cake" or "fq_codel"</b>, pick that. It's the most effective option.</li>
      <li>Save, wait a minute, then <b>run this test again</b>. If the grade is still C or worse, try the lower limits: ${d80} / ${u80} Mbps (80%).</li>
    </ol>
    <div class="callout warn small">
      <b>Two caveats.</b> Speeds measured over weak Wi‑Fi can be limited by the Wi‑Fi link rather than your internet plan. For the most accurate limits, run the test next to the router or on Ethernet.
      If your router has no QoS option at all (common on ISP routers), the fix is a router that supports SQM, or putting your own router behind the ISP box.
    </div>`;
}

function drawChart(pings, phases) {
  const { ctx, w, h } = setupCanvas($('chart'));
  const pad = 40, top = 10, bot = 22;
  pings = pings || [];
  const ok = pings.map(p => p[1]).filter(v => v != null).sort((a, b) => a - b);
  const p98 = ok.length ? ok[Math.floor(ok.length * 0.98)] : 100;
  const ymax = Math.max(50, p98 * 1.15);
  const tmax = Math.max(EXPECTED, ...(pings.map(p => p[0])), ...(phases ? Object.values(phases).flat().filter(v => v != null) : []));
  const x = t => pad + t / tmax * (w - pad - 6), y = v => top + (1 - clamp(v, 0, ymax) / ymax) * (h - top - bot);

  if (phases) {
    const shade = { idle: css('--track'), download: 'rgba(47,111,237,.18)', upload: 'rgba(232,104,26,.18)' };
    Object.entries(phases).forEach(([k, [a, b]]) => {
      if (a == null || b == null) return;
      ctx.fillStyle = shade[k]; ctx.fillRect(x(a), top, x(b) - x(a), h - top - bot);
    });
  }
  ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--muted'); ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
  const step = ymax > 1500 ? 500 : ymax > 600 ? 200 : ymax > 250 ? 100 : ymax > 100 ? 50 : 25;
  for (let v = 0; v <= ymax; v += step) {
    ctx.beginPath(); ctx.moveTo(pad, y(v) + .5); ctx.lineTo(w, y(v) + .5); ctx.stroke();
    ctx.fillText(v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`, 2, y(v));
  }
  ctx.textBaseline = 'top';
  for (let t = 0; t <= tmax; t += 10) ctx.fillText(`${t}s`, x(t) - 6, h - bot + 6);
  if (!pings.length) {
    ctx.textAlign = 'center'; ctx.fillText('Start a test to see how ping behaves under load', w / 2, h / 2 - 10); ctx.textAlign = 'start';
    return;
  }
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath(); let pen = false;
  pings.forEach(([t, v]) => {
    if (v == null) { pen = false; return; }
    pen ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v)); pen = true;
  });
  ctx.stroke();
  ctx.fillStyle = css('--bad');
  pings.forEach(([t, v]) => { if (v == null) ctx.fillRect(x(t) - 1, top, 2, 8); });
}

function renderHistory(hist) {
  const tb = $('hist').querySelector('tbody'); tb.innerHTML = '';
  $('hist').hidden = !hist.length; $('noHist').hidden = !!hist.length;
  [...hist].reverse().forEach((r, i, arr) => {
    const prev = arr[i + 1];
    const worst = x => Math.max(x.dlAdded || 0, x.ulAdded || 0);
    let cmp = '';
    if (prev) {
      const d = worst(prev) - worst(r);
      cmp = Math.abs(d) < 10 ? '<span class="muted">about the same</span>'
        : d > 0 ? `<span style="color:var(--excellent)">▼ ${fmt(d, 0)} ms less lag</span>` : `<span style="color:var(--bad)">▲ ${fmt(-d, 0)} ms more lag</span>`;
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtTime(r.at)}</td><td><span class="g" style="background:${css(GRADE_COLOR(r.grade))}">${r.grade}</span></td>
      <td>${fmt(r.down, 0)} / ${fmt(r.up, 0)} Mbps</td><td>${fmt(r.idle, 0)} ms</td>
      <td>+${fmt(r.dlAdded, 0)} ms</td><td>+${fmt(r.ulAdded, 0)} ms</td><td>${cmp}</td>`;
    tb.append(tr);
  });
}
window.addEventListener('resize', () => state && render());
refresh();
