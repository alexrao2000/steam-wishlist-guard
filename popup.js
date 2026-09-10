const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const errEl = document.getElementById('err');

chrome.runtime.sendMessage({ type: 'clear-badge' }).catch(() => {});

function ago(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

async function render() {
  const { log = [], snapshot, lastCheck, lastError } = await chrome.storage.local.get(
    ['log', 'snapshot', 'lastCheck', 'lastError']
  );

  const size = Array.isArray(snapshot) ? `${snapshot.length} games watched` : 'no baseline yet';
  statusEl.textContent = lastCheck ? `${size} · checked ${ago(lastCheck)}` : size;

  if (lastError) {
    errEl.hidden = false;
    errEl.textContent = `Last check failed: ${lastError.message}`;
  } else {
    errEl.hidden = true;
  }

  listEl.textContent = '';
  if (!log.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = Array.isArray(snapshot)
      ? 'No removals logged. Nothing lost so far.'
      : 'Open store.steampowered.com signed in, then hit “Check now” to set a baseline.';
    listEl.append(p);
    return;
  }

  for (const entry of log) {
    const li = document.createElement('li');
    if (entry.restored) li.classList.add('restored');

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('div');
    name.className = 'name';
    const link = document.createElement('a');
    link.href = `https://store.steampowered.com/app/${entry.appid}/`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = entry.name || `App ${entry.appid}`;
    name.append(link);

    const when = document.createElement('div');
    when.className = 'when';
    const how = entry.detectedBy === 'click' ? 'caught on click' : 'caught by check';
    when.textContent = `${entry.appid} · removed ${ago(entry.removedAt)} · ${how}${entry.restored ? ' · restored' : ''}`;

    meta.append(name, when);

    const btn = document.createElement('button');
    btn.textContent = entry.restored ? 'Restored' : 'Restore';
    btn.disabled = !!entry.restored;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      const res = await chrome.runtime.sendMessage({ type: 'restore', appid: entry.appid });
      if (res?.ok) {
        render();
      } else {
        errEl.hidden = false;
        errEl.textContent = res?.reason || 'Restore failed.';
        btn.disabled = false;
        btn.textContent = 'Restore';
      }
    });

    li.append(meta, btn);
    listEl.append(li);
  }
}

const toggle = document.getElementById('confirmToggle');
chrome.storage.local.get('confirmEnabled').then(({ confirmEnabled }) => {
  // Unset means never configured, and confirming is the default.
  toggle.checked = confirmEnabled !== false;
});
toggle.addEventListener('change', () => {
  chrome.storage.local.set({ confirmEnabled: toggle.checked });
});

document.getElementById('check').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  await chrome.runtime.sendMessage({ type: 'snapshot-now' });
  ev.target.disabled = false;
  render();
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ log: [] });
  render();
});

render();
