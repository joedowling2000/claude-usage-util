const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, session, dialog } = require('electron');
const path = require('path');
const { execFileSync } = require('child_process');

const USAGE_PAGE = 'https://claude.ai/settings/usage';
const REFRESH_MS = 5 * 60 * 1000; // 5 min

let widgetWin = null;
let loginWin = null;
let tray = null;
let refreshTimer = null;
let lastData = null;
let logoDataUri = null;

// ---------- windows ----------

function createWidget() {
  widgetWin = new BrowserWindow({
    width: 320,
    height: 96,
    x: 40,
    y: 60,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  widgetWin.setAlwaysOnTop(true, 'floating');
  widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWin.loadFile(path.join(__dirname, 'renderer.html'));
  widgetWin.once('ready-to-show', () => widgetWin.show());
}

function openLoginWindow(onDone) {
  if (loginWin) { loginWin.focus(); return; }
  loginWin = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Log in to Claude',
    webPreferences: {
      partition: 'persist:claude',
    },
  });
  // Allow SSO popups (Google, etc.)
  loginWin.webContents.setWindowOpenHandler(({ url }) => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 520,
      height: 700,
      webPreferences: { partition: 'persist:claude' },
    },
  }));

  loginWin.loadURL('https://claude.ai/login');

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    loginWin = null;
    onDone && onDone();
  };

  // Poll cookies every second — survives SPA navigation that doesn't fire events
  const poll = setInterval(async () => {
    try {
      const cookies = await session.fromPartition('persist:claude').cookies.get({ domain: 'claude.ai' });
      if (cookies.some(c => c.name === 'sessionKey')) finish();
    } catch {}
  }, 1000);

  loginWin.on('closed', () => { clearInterval(poll); loginWin = null; if (!done) onDone && onDone(); });
}

// ---------- logo fetch ----------

async function fetchLogo() {
  // Cache in userData dir so we only download once
  const fs = require('fs');
  const cachePath = path.join(app.getPath('userData'), 'claude-logo.png');
  if (fs.existsSync(cachePath)) {
    const buf = fs.readFileSync(cachePath);
    logoDataUri = 'data:image/png;base64,' + buf.toString('base64');
    return;
  }
  try {
    const bg = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:claude' } });
    await bg.loadURL('https://claude.ai/').catch(() => {});
    // Try a few known logo paths
    const urls = [
      'https://claude.ai/images/claude_app_icon.png',
      'https://claude.ai/favicon.ico',
      'https://claude.ai/apple-touch-icon.png',
    ];
    let dataUri = null;
    for (const u of urls) {
      dataUri = await bg.webContents.executeJavaScript(`
        fetch(${JSON.stringify(u)}).then(async r => {
          if (!r.ok) return null;
          const blob = await r.blob();
          return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
        }).catch(() => null)
      `).catch(() => null);
      if (dataUri && typeof dataUri === 'string' && dataUri.startsWith('data:image')) break;
      dataUri = null;
    }
    bg.destroy();
    if (dataUri) {
      logoDataUri = dataUri;
      const m = dataUri.match(/^data:[^;]+;base64,(.+)$/);
      if (m) fs.writeFileSync(cachePath, Buffer.from(m[1], 'base64'));
    }
  } catch {}
}

// ---------- keychain ----------

function keychainGet(serviceName) {
  try {
    const out = execFileSync('/usr/bin/security',
      ['find-generic-password', '-a', process.env.USER || '', '-s', serviceName, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim();
  } catch { return null; }
}

function keychainSet(serviceName, value) {
  try {
    execFileSync('/usr/bin/security',
      ['add-generic-password', '-U', '-a', process.env.USER || '', '-s', serviceName, '-w', value],
      { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function seedSessionFromKeychain() {
  const sk = keychainGet('claude-usage-session');
  const org = keychainGet('claude-usage-orgid');
  if (!sk) return { ok: false, reason: 'no_keychain' };

  const ses = session.fromPartition('persist:claude');
  // Inject sessionKey cookie
  await ses.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sk,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180,
  }).catch(() => {});
  if (org) {
    await ses.cookies.set({
      url: 'https://claude.ai',
      name: 'lastActiveOrg',
      value: org,
      domain: '.claude.ai',
      path: '/',
      secure: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180,
    }).catch(() => {});
  }
  return { ok: true };
}

// ---------- fetching ----------

async function findOrgId() {
  // lastActiveOrg cookie is set by the site after login
  const cookies = await session.fromPartition('persist:claude').cookies.get({ domain: 'claude.ai' });
  const c = cookies.find(c => c.name === 'lastActiveOrg');
  return c ? c.value : null;
}

async function fetchUsage() {
  const ses = session.fromPartition('persist:claude');
  const cookies = await ses.cookies.get({ domain: 'claude.ai' });
  const hasSession = cookies.some(c => c.name === 'sessionKey');
  if (!hasSession) return { error: 'not_logged_in' };

  let orgId = await findOrgId();
  if (!orgId) {
    // Trigger the cookie to be set by visiting the settings page invisibly
    const probe = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:claude' } });
    await probe.loadURL(USAGE_PAGE).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));
    orgId = await findOrgId();
    probe.destroy();
  }
  if (!orgId) return { error: 'no_org_id' };

  const url = `https://claude.ai/api/organizations/${orgId}/usage`;
  try {
    // fetch from inside Electron main uses Node's fetch which does NOT share the partition cookies.
    // So we run the fetch inside a hidden BrowserWindow's context.
    const bg = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:claude' } });
    await bg.loadURL(USAGE_PAGE).catch(() => {});
    const json = await bg.webContents.executeJavaScript(`
      fetch(${JSON.stringify(url)}, {
        credentials: 'include',
        headers: { 'accept': '*/*', 'anthropic-client-platform': 'web_claude_ai', 'content-type': 'application/json' }
      }).then(r => r.ok ? r.text() : Promise.reject('http ' + r.status))
    `).catch(err => ({ __err: String(err) }));
    bg.destroy();

    if (json && json.__err) return { error: json.__err };
    const data = JSON.parse(json);
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

function msToHuman(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const d = t - Date.now();
  if (d <= 0) return 'now';
  const s = Math.floor(d / 1000);
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

async function refresh() {
  // Ensure session partition has sessionKey; seed from Keychain if missing
  const ses = session.fromPartition('persist:claude');
  let cookies = await ses.cookies.get({ domain: 'claude.ai' });
  if (!cookies.some(c => c.name === 'sessionKey')) {
    const seeded = await seedSessionFromKeychain();
    if (!seeded.ok) {
      send({ state: 'error', message: 'No sessionKey in Keychain. Use tray → "Paste new sessionKey".' });
      return;
    }
  }

  const res = await fetchUsage();
  if (res.error === 'not_logged_in') {
    send({ state: 'error', message: 'sessionKey expired. Tray → "Paste new sessionKey".' });
    return;
  }
  if (res.error) {
    send({ state: 'error', message: res.error });
    return;
  }
  lastData = res.data;
  const fh = res.data.five_hour || {};
  const sd = res.data.seven_day || {};
  const eu = res.data.extra_usage || {};
  send({
    state: 'ok',
    session: fh.utilization ?? null,
    sessionResetsIn: msToHuman(fh.resets_at),
    sessionResetsAt: fh.resets_at,
    week: sd.utilization ?? null,
    weekResetsIn: msToHuman(sd.resets_at),
    weekResetsAt: sd.resets_at,
    extra: eu && eu.is_enabled ? { util: eu.utilization, used: eu.used_credits, limit: eu.monthly_limit, currency: eu.currency } : null,
    updated: Date.now(),
    logo: logoDataUri,
  });
}

function send(payload) {
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.webContents.send('usage', payload);
  }
}

// ---------- tray ----------

function buildTray() {
  const img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setTitle('Claude');
  updateTrayMenu();
}

function updateTrayMenu() {
  const items = [
    { label: 'Refresh now', click: () => refresh() },
    { label: 'Open usage page', click: () => shell.openExternal(USAGE_PAGE) },
    { label: 'Paste new sessionKey from clipboard…', click: () => pasteNewSessionKey() },
    { type: 'separator' },
    { label: 'Show widget', click: () => widgetWin && widgetWin.show() },
    { label: 'Hide widget', click: () => widgetWin && widgetWin.hide() },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked, openAsHidden: false }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

async function pasteNewSessionKey() {
  const { clipboard } = require('electron');
  const val = (clipboard.readText() || '').trim();
  if (!/^sk-ant-sid0\d-/.test(val)) {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Clipboard does not contain a valid sessionKey',
      detail: 'Copy the sessionKey cookie value from claude.ai (DevTools → Application → Cookies → sessionKey), then try again.\n\nIt should start with "sk-ant-sid02-".',
    });
    return;
  }
  keychainSet('claude-usage-session', val);
  // Clear stale cookies from partition so the new one is used
  const ses = session.fromPartition('persist:claude');
  const existing = await ses.cookies.get({ domain: 'claude.ai', name: 'sessionKey' });
  for (const c of existing) {
    await ses.cookies.remove('https://claude.ai', c.name).catch(() => {});
  }
  await refresh();
  dialog.showMessageBox({ type: 'info', message: 'sessionKey updated', detail: 'Widget refreshed.' });
}

// ---------- IPC ----------

ipcMain.handle('open-usage', () => shell.openExternal(USAGE_PAGE));
ipcMain.handle('request-refresh', () => refresh());

// ---------- app lifecycle ----------

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWidget();
  buildTray();
  fetchLogo().then(() => { if (lastData) send({ ...toPayload(lastData), logo: logoDataUri }); }).catch(() => {});
  await refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
});

function toPayload(data) {
  const fh = data.five_hour || {}, sd = data.seven_day || {}, eu = data.extra_usage || {};
  return {
    state: 'ok',
    session: fh.utilization ?? null,
    sessionResetsIn: msToHuman(fh.resets_at),
    week: sd.utilization ?? null,
    weekResetsIn: msToHuman(sd.resets_at),
    extra: eu && eu.is_enabled ? { util: eu.utilization, used: eu.used_credits, limit: eu.monthly_limit, currency: eu.currency } : null,
  };
}

app.on('window-all-closed', (e) => { e.preventDefault(); });
