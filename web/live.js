mountNav('index.html');
const HIST = 120; // 60 s at 2 Hz
const hist = [];
let peak = null, recording = false, spots = [], soundOn = false, audio = null;

startLive((d, connected) => {
  const r = connected ? d.rssi : null;
  hist.push({ rssi: r, ping: d.ping, inet: d.inet });
  if (hist.length > HIST) hist.shift();
  if (r != null && (peak == null || r > peak)) peak = r;

  const q = quality(r);
  $('rssi').textContent = fmt(r);
  $('qlabel').textContent = q.name;
  $('qlabel').style.color = q.color;
  const arc = $('arc');
  arc.setAttribute('stroke-dasharray', `${r == null ? 0 : clamp((r + 92) / 52, 0.02, 1) * 100} 100`);
  arc.setAttribute('stroke', q.color);
  $('peak').textContent = peak != null ? `Best this session: ${fmt(peak)} dBm` : '';

  const rs = hist.map(h => h.rssi).filter(x => x != null), tr = $('trend');
  if (rs.length >= 12) {
    const diff = avg(rs.slice(-4)) - avg(rs.slice(-16, -4));
    if (diff >= 2) { tr.className = 'trend up'; tr.textContent = '▲ Getting better'; }
    else if (diff <= -2) { tr.className = 'trend down'; tr.textContent = '▼ Getting worse'; }
    else { tr.className = 'trend flat'; tr.textContent = 'Steady'; }
  }

  const snr = connected && d.noise ? d.rssi - d.noise : null;
  $('snr').textContent = snr == null ? '--' : `${snr} dB`;
  $('snr').style.color = snr == null ? '' : snr >= 25 ? css('--excellent') : snr >= 15 ? css('--fair') : css('--bad');
  $('tx').textContent = connected ? `${Math.round(d.tx)} Mbps` : '--';
  $('ping').textContent = d.ping == null ? '--' : `${fmt(d.ping, 1)} ms`;
  $('pingh').textContent = d.jitter == null ? 'jitter / loss' : `jitter ${fmt(d.jitter, 1)} ms · loss ${d.loss ?? 0}%`;
  $('inet').textContent = d.inet == null ? '--' : `${fmt(d.inet, 1)} ms`;
  $('ineth').textContent = d.inetLoss == null ? `to ${d.internetHost}` : `to ${d.internetHost} · loss ${d.inetLoss}%`;
  draw();
});

function draw() {
  { const { ctx, w, h } = setupCanvas($('chart'));
    const lo = -95, hi = -40, pad = 34, y = v => h - 8 - (clamp(v, lo, hi) - lo) / (hi - lo) * (h - 16);
    const x = i => pad + (i + HIST - hist.length) / (HIST - 1) * (w - pad - 4);
    ctx.textBaseline = 'middle';
    [[-55, '--excellent'], [-65, '--good'], [-72, '--fair'], [-80, '--weak']].forEach(([v, c]) => {
      ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(pad, y(v)); ctx.lineTo(w, y(v)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css(c); ctx.fillText(String(v).replace('-', '−'), 2, y(v));
    });
    ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
    for (let i = 1; i < hist.length; i++) {
      const a = hist[i - 1].rssi, b = hist[i].rssi;
      if (a == null || b == null) continue;
      ctx.strokeStyle = quality(b).color;
      ctx.beginPath(); ctx.moveTo(x(i - 1), y(a)); ctx.lineTo(x(i), y(b)); ctx.stroke();
    }
  }
  { const { ctx, w, h } = setupCanvas($('pchart'));
    const ps = hist.map(p => p.ping).filter(v => v != null);
    const hi = Math.max(20, ...ps) * 1.1, pad = 34, y = v => h - 4 - v / hi * (h - 8);
    const x = i => pad + (i + HIST - hist.length) / (HIST - 1) * (w - pad - 4);
    ctx.textBaseline = 'middle'; ctx.fillStyle = css('--muted');
    ctx.fillText(`${Math.round(hi)} ms`, 2, 8); ctx.fillText('router', 2, h - 10);
    ctx.fillStyle = css('--accent');
    hist.forEach((p, i) => {
      if (p.ping == null) return;
      const bh = Math.max(1.5, h - 4 - y(p.ping));
      ctx.fillRect(x(i) - 1.5, h - 4 - bh, 3, bh);
    });
  }
}
window.addEventListener('resize', draw);

// geiger-counter sound
$('sound').onclick = () => {
  soundOn = !soundOn;
  $('sound').textContent = soundOn ? '🔊 Sound on' : '🔈 Sound off';
  if (soundOn) { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); beepLoop(); }
};
function beepLoop() {
  if (!soundOn) return;
  const r = live.latest?.rssi || -95, t = clamp((r + 90) / 45, 0, 1);
  const osc = audio.createOscillator(), g = audio.createGain(), now = audio.currentTime;
  osc.frequency.value = 330 + t * 990;
  g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  osc.connect(g).connect(audio.destination); osc.start(now); osc.stop(now + 0.1);
  setTimeout(beepLoop, 900 - t * 780);
}

// spots
$('recBtn').onclick = () => {
  if (recording) return;
  const name = $('spotName').value.trim() || `Spot ${spots.length + 1}`;
  recording = true;
  $('recBtn').disabled = $('spotName').disabled = true;
  $('prog').style.visibility = 'visible';
  $('recStatus').textContent = `Recording “${name}”… hold still.`;
  recordSpot({
    name,
    onProgress: p => $('prog').firstElementChild.style.width = `${p * 100}%`,
    onDone: async spot => {
      recording = false;
      $('recBtn').disabled = $('spotName').disabled = false;
      $('spotName').value = ''; $('prog').style.visibility = 'hidden';
      $('prog').firstElementChild.style.width = '0';
      if (!spot) { $('recStatus').textContent = 'Not enough signal data. Are you connected to Wi‑Fi?'; return; }
      spots = await loadSpots(); spots.push(spot); saveSpots(spots); renderSpots();
      $('recStatus').textContent = `Saved “${name}”: ${fmt(spot.rssi, 1)} dBm, score ${spot.score}. Move to the next spot.`;
    },
  });
};
function renderSpots() {
  const tb = $('spots').querySelector('tbody'); tb.innerHTML = '';
  $('spots').hidden = !spots.length; $('noSpots').hidden = !!spots.length;
  spots.map((s, i) => ({ s, i })).sort((a, b) => b.s.score - a.s.score).forEach(({ s, i }, rank) => {
    const q = quality(s.rssi), tr = document.createElement('tr');
    tr.innerHTML = `<td>${rank + 1}</td>
      <td>${esc(s.name)}${rank === 0 && spots.length > 1 ? '<span class="badge">BEST</span>' : ''}</td>
      <td><div class="scorebar"><div class="bar"><div style="width:${s.score}%;background:${q.color}"></div></div><b>${s.score}</b></div></td>
      <td style="color:${q.color}" title="range ${s.min} to ${s.max} dBm">${fmt(s.rssi, 1)} dBm</td>
      <td class="hide-sm">${s.ping == null ? '--' : fmt(s.ping, 1) + ' ms'}</td>
      <td class="hide-sm">${s.tx} Mbps</td>
      <td><button class="del" title="Remove">×</button></td>`;
    tr.querySelector('.del').onclick = () => { spots.splice(i, 1); saveSpots(spots); renderSpots(); };
    tb.append(tr);
  });
}
loadSpots().then(s => { spots = s; renderSpots(); });
