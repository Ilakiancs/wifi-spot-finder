mountNav('devices.html');
startLive();
let state = null, editing = null;

const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

$('scan').onclick = async () => {
  $('scan').disabled = true;
  $('status').textContent = 'Scanning your network… (about 10 seconds)';
  try { state = await post('/api/devices/scan'); } catch { $('status').textContent = 'Scan failed. Are you connected to Wi-Fi?'; }
  $('scan').disabled = false;
  render();
};
$('auto').onchange = async () => { state = await post('/api/devices/settings', { auto: $('auto').checked }); render(); };

async function load() {
  state = await api('/api/devices');
  if (!state.lastScan && !state.scanning) return $('scan').click();
  render();
}

function displayName(d) {
  if (d.label) return d.label;
  if (d.isThisMac) return 'This Mac';
  if (d.isRouter) return 'Router';
  if (d.name) return d.name.replace(/\.(local|lan|home)$/i, '');
  if (d.vendor) return `${d.vendor.split(/[ ,]/)[0]} device`;
  return d.private ? 'Private device' : 'Unknown device';
}

function ago(t) {
  const s = Date.now() / 1000 - t;
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : fmtTime(t);
}

function render() {
  if (editing) return;  // don't wipe an open rename box
  const ds = state.devices, online = ds.filter(d => d.online);
  $('auto').checked = !!state.settings.auto;
  const tile = (k, v, h, color) => `<div class="tile"><div class="k">${k}</div><div class="v" ${color ? `style="color:${color}"` : ''}>${v}</div><div class="h">${h}</div></div>`;
  const fresh = ds.filter(d => d.isNew);
  $('tiles').innerHTML =
    tile('Online now', online.length, `on ${state.network || 'your network'}`) +
    tile('Seen before', ds.length, 'all-time') +
    tile('New', fresh.length, fresh.length ? 'not marked as known yet' : 'nothing unfamiliar', fresh.length ? css('--weak') : css('--excellent')) +
    tile('Private addresses', ds.filter(d => d.private && !d.isThisMac).length, 'maker hidden by the device');
  $('status').textContent = state.scanning ? 'Scanning…' :
    `Last scan ${state.lastScan ? ago(state.lastScan) : 'never'}.${state.vendorsLoading ? ' Downloading the list of device makers in the background. Names fill in shortly.' : ''}`;

  const tb = $('list').querySelector('tbody'); tb.innerHTML = '';
  $('empty').hidden = !!ds.length;
  ds.forEach(d => {
    const tr = document.createElement('tr');
    if (!d.online) tr.className = 'offline';
    const tags = (d.isNew ? '<span class="tag new">NEW</span>' : '') + (d.isThisMac ? '<span class="tag you">this Mac</span>' : '') + (d.isRouter ? '<span class="tag">router</span>' : '');
    const sub = d.label && d.name ? `<div class="sub">${esc(d.name)}</div>` : '';
    tr.innerHTML = `<td><span class="on-dot ${d.online ? 'live' : ''}"></span><span class="name" title="Click to rename">${esc(displayName(d))}</span>${tags}${sub}</td>
      <td>${esc(d.ip || '')}</td>
      <td class="hide-sm">${d.vendor ? esc(d.vendor) : d.private ? '<span class="muted">private address</span>' : '<span class="muted">unknown</span>'}</td>
      <td class="hide-sm mac">${esc(d.mac)}</td>
      <td>${d.online ? 'online' : ago(d.lastSeen)}</td>
      <td style="white-space:nowrap">${d.isNew ? '<button class="act known">Mark known</button>' : ''}${!d.online && !d.isThisMac ? ' <button class="del" title="Forget">×</button>' : ''}</td>`;
    tr.querySelector('.name').onclick = () => rename(tr, d);
    tr.querySelector('.known')?.addEventListener('click', async () => { state = await post('/api/devices/update', { mac: d.mac, known: true }); render(); });
    tr.querySelector('.del')?.addEventListener('click', async () => { state = await post('/api/devices/forget', { mac: d.mac }); render(); });
    tb.append(tr);
  });
}

function rename(tr, d) {
  const span = tr.querySelector('.name'), input = document.createElement('input');
  input.className = 'rename'; input.value = d.label || ''; input.placeholder = displayName(d); input.maxLength = 40;
  span.replaceWith(input); input.focus(); editing = d.mac;
  const done = async save => {
    if (editing !== d.mac) return;
    editing = null;
    if (save) state = await post('/api/devices/update', { mac: d.mac, label: input.value, known: true });
    render();
  };
  input.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
}

load();
setInterval(async () => { if (!editing) { state = await api('/api/devices'); render(); } }, 15000);
