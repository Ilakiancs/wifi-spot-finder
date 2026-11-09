mountNav('dns.html');
startLive();
let state = null, polling = null, startedAt = null;
const SECOND = { Cloudflare: '1.0.0.1', Google: '8.8.4.4', Quad9: '149.112.112.112', OpenDNS: '208.67.220.220', AdGuard: '94.140.15.15' };

$('run').onclick = async () => {
  await api('/api/dns/run', { method: 'POST' });
  startedAt = Date.now();
  load();
};

async function load() {
  state = await api('/api/dns');
  render();
  if (state.running && !polling) polling = setInterval(load, 1000);
  if (!state.running && polling) { clearInterval(polling); polling = null; }
}

function render() {
  const r = state.result;
  $('run').disabled = state.running;
  $('status').textContent = state.running ? `Testing… ${startedAt ? Math.round((Date.now() - startedAt) / 1000) + ' s' : ''}` : r ? `Last run ${fmtTime(r.at)}` : '';
  if (!r) return;
  $('resultsCard').hidden = $('howCard').hidden = false;
  $('gw').textContent = live.latest?.gateway || '192.168.1.1';

  const ok = r.servers.filter(s => s.score != null);
  const best = ok[0], current = r.servers.filter(s => s.current).sort((a, b) => (a.score ?? 1e9) - (b.score ?? 1e9))[0];
  let v = '';
  if (best && current && best.ip !== current.ip && current.score != null) {
    const saved = current.cached - best.cached;
    if (best.name === 'Your router') {
      v = `<div class="callout">Your router answers fastest (${fmt(best.cached, 0)} ms vs ${fmt(current.cached, 0)} ms) because it keeps its own cache. It passes everything else on to whatever DNS it's set to use, usually your ISP's, so switching to it can trade a little privacy for speed. Your current ${esc(current.name)} setup is a fine choice too.</div>`;
    } else if (saved >= 5 && best.cached < current.cached * 0.8) {
      v = `<div class="callout good"><b>${esc(best.name)}</b> is faster here: about ${fmt(best.cached, 0)} ms per everyday lookup vs ${fmt(current.cached, 0)} ms for your current DNS (${esc(current.name)}). That's ${fmt(saved, 0)} ms off the start of every new site you open.</div>`;
    } else {
      v = `<div class="callout good">Your current DNS (${esc(current.name)}) is about as fast as the alternatives (${fmt(current.cached, 0)} ms). No need to change anything.</div>`;
    }
  } else if (current && best && best.ip === current.ip) {
    v = `<div class="callout good">Your current DNS (${esc(current.name)}) is the fastest one I tested (${fmt(current.cached, 0)} ms per lookup). Nothing to change.</div>`;
  }
  $('verdict').innerHTML = v;

  const max = Math.max(1, ...ok.map(s => s.cached));
  const tb = $('results').querySelector('tbody'); tb.innerHTML = '';
  r.servers.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (s.current) tr.className = 'mine';
    const color = s.cached == null ? css('--bad') : s.cached < 20 ? css('--excellent') : s.cached < 60 ? css('--fair') : css('--weak');
    tr.innerHTML = `<td>${esc(s.name)}${s.current ? '<span class="tag you">current</span>' : ''}${i === 0 && s.score != null ? '<span class="tag best">fastest</span>' : ''}
        <div class="sub">${esc(s.ip)}${s.note ? ` · ${esc(s.note)}` : ''}</div></td>
      <td>${s.unreachable ? '<span style="color:var(--bad)">didn\'t answer</span>' : `<div class="row" style="flex-wrap:nowrap"><div class="bar" style="flex:1"><div style="width:${(s.cached || 0) / max * 100}%;background:${color}"></div></div><span>${fmt(s.cached, 0)} ms</span></div>`}</td>
      <td class="hide-sm">${s.uncached == null ? '--' : fmt(s.uncached, 0) + ' ms'}</td>
      <td class="hide-sm" ${s.failPct ? 'style="color:var(--weak)"' : ''}>${s.failPct}%</td>`;
    tb.append(tr);
  });

  const pick = best && best.name !== 'Your router' ? best : ok.find(s => s.name !== 'Your router');
  $('addresses').textContent = pick && SECOND[pick.name] ? `${pick.name}'s addresses: ${pick.ip} and ${SECOND[pick.name]}` : '';
}

load();
