# Claude Pulse

A tiny, always-on-top macOS desktop widget that shows your **Claude.ai plan usage** at a glance — the current 5-hour session %, the 7-day weekly %, and (when you're near the limit) your extra-credit balance.

Built with Electron. Pulls data from the same `/api/organizations/<id>/usage` endpoint the Claude settings page uses, inside a real Chromium session (so it passes Cloudflare cleanly).

![widget states: green, amber, red](#) <!-- add a screenshot later -->

## Features

- **Floating pill** — frameless, translucent, always on top, draggable, visible on all Spaces/fullscreen apps.
- **Live usage** — ⚡ 5-hour session % + 📅 7-day weekly %, refreshed every 5 minutes.
- **Traffic-light tint** — pill turns green ≤50%, amber 51–80%, red ≥81% (based on the worst of session / week).
- **Overage details** — when session ≥81%, extra rows appear: `Current balance` + `Monthly spend limit remaining`.
- **Session reset countdown** shown inline next to the session %.
- **Click** the pill → opens `claude.ai/settings/usage` in your browser.
- **Right-click** the pill → force refresh.
- **Menu-bar tray** for refresh, session-key rotation, start-at-login, quit.

## How it works

1. On first launch the widget reads a `sessionKey` (Claude's auth cookie) from the macOS **Keychain** and seeds it into Electron's private `persist:claude` session.
2. A hidden background `BrowserWindow` then calls `https://claude.ai/api/organizations/<orgId>/usage` using the real Chromium fingerprint — Cloudflare lets the request through and we get JSON.
3. The renderer pill displays the numbers and tints the background based on thresholds.

Because the request originates from a real Chromium context, the Cloudflare `cf_clearance` cookie is obtained and refreshed automatically — no fingerprint-faking nonsense required.

## Install

### Prereqs

- macOS (tested on Apple Silicon)
- Node 20+ and npm
- [SwiftBar](https://swiftbar.app/) is **not** required — that was an earlier abandoned attempt (see `claude-usage.5m.sh` for the shell/SwiftBar stub kept as a curiosity; it doesn't work reliably due to Cloudflare).

### 1. Clone and install

```bash
git clone <your-remote-url> claude-pulse
cd claude-pulse/electron
npm install
```

### 2. Grab your Claude `sessionKey`

1. In Chrome / Edge / Safari, log into `https://claude.ai`.
2. Open DevTools → **Application** → **Cookies** → `https://claude.ai`.
3. Copy the value of the `sessionKey` cookie (starts with `sk-ant-sid02-…`).
4. Also grab the `lastActiveOrg` cookie value (a UUID) — this is your organization ID.

### 3. Store the secrets in macOS Keychain

```bash
security add-generic-password -U -a "$USER" -s claude-usage-session -w 'sk-ant-sid02-PASTE_HERE'
security add-generic-password -U -a "$USER" -s claude-usage-orgid   -w 'PASTE-ORG-UUID-HERE'
```

### 4. Run

```bash
npm start
```

You should see a small translucent pill appear in the top-left of your screen showing `Claude` and your current usage.

## Build a standalone `.app`

```bash
cd electron
npx electron-builder --mac --arm64
```

The bundle ends up at `electron/dist/mac-arm64/Claude Usage.app`. Drag it to `/Applications`, then open the app and use the tray menu to tick **Start at login**.

## Rotating an expired `sessionKey`

Claude's session cookie is long-lived but eventually rotates. When you see `⚠️ sessionKey expired…` in the pill:

1. Log into `claude.ai` in your normal browser.
2. DevTools → Cookies → copy the new `sessionKey` value to your clipboard.
3. Click the **Claude** tray icon → **Paste new sessionKey from clipboard…**.
4. Done. The widget refreshes immediately.

(Or use the `security add-generic-password -U …` command to update directly.)

## File map

```
claude-pulse/
├── README.md                     — this file
├── .gitignore
├── claude-usage.5m.sh            — legacy SwiftBar attempt (doesn't work — Cloudflare)
└── electron/
    ├── package.json
    ├── main.js                   — Electron main process: window, tray, fetch, Keychain
    ├── preload.js                — IPC bridge
    ├── renderer.html             — the pill UI (HTML/CSS/JS)
    └── .gitignore
```

## Notes

- **Auth:** this widget relies on the **same cookie your browser uses**. It does nothing more privileged than opening that URL in a browser would.
- **Font:** the "Claude" wordmark uses a serif fallback stack (`Copernicus`, `Tiempos Headline`, `Source Serif Pro`, Georgia). Anthropic's actual typefaces (Styrene B / Copernicus) are proprietary and not shipped here.
- **Logo:** not embedded — to avoid any trademark ambiguity, the widget uses a typographic wordmark only.
- **Refresh cadence:** 5 minutes. Edit `REFRESH_MS` in `electron/main.js` to change it.

## License

MIT — personal project.
