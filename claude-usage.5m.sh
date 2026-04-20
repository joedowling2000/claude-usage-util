#!/bin/bash
# <bitbar.title>Claude Usage</bitbar.title>
# <bitbar.version>v0.1</bitbar.version>
# <bitbar.author>joe</bitbar.author>
# <bitbar.desc>Shows Claude.ai plan usage (5h session + 7d weekly) in the menu bar.</bitbar.desc>
# <bitbar.dependencies>bash,python3,curl,security</bitbar.dependencies>
#
# SwiftBar / xbar plugin.
# Filename cadence: claude-usage.5m.sh  => refreshes every 5 minutes.
#
# One-time setup (run these in Terminal):
#   security add-generic-password -U -a "$USER" -s claude-usage-session -w 'PASTE_sessionKey_VALUE'
#   security add-generic-password -U -a "$USER" -s claude-usage-orgid   -w 'PASTE_ORG_UUID'
#
# sessionKey = the cookie value starting with "sk-ant-sid02-..." from claude.ai
# ORG_UUID   = the UUID from the /api/organizations/<UUID>/usage URL

set -u

SERVICE_SESSION="claude-usage-session"
SERVICE_ORG="claude-usage-orgid"
SERVICE_CFCLR="claude-usage-cfclearance"

get_secret() {
  security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null
}

SESSION_KEY="$(get_secret "$SERVICE_SESSION" || true)"
ORG_ID="$(get_secret "$SERVICE_ORG" || true)"
CF_CLEARANCE="$(get_secret "$SERVICE_CFCLR" || true)"

if [[ -z "${SESSION_KEY:-}" || -z "${ORG_ID:-}" ]]; then
  echo "⚠️ Claude"
  echo "---"
  echo "Missing Keychain entries"
  echo "Run setup commands (see plugin source) | color=orange"
  echo "Open Claude usage page | href=https://claude.ai/settings/usage"
  exit 0
fi

URL="https://claude.ai/api/organizations/${ORG_ID}/usage"

RESPONSE="$(curl -sS --max-time 10 "$URL" \
  -H 'accept: */*' \
  -H 'anthropic-client-platform: web_claude_ai' \
  -H 'content-type: application/json' \
  -H "referer: https://claude.ai/settings/usage" \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' \
  -b "sessionKey=${SESSION_KEY}; lastActiveOrg=${ORG_ID}${CF_CLEARANCE:+; cf_clearance=${CF_CLEARANCE}}" 2>/dev/null)"

if [[ -z "$RESPONSE" ]]; then
  echo "⚠️ Claude"
  echo "---"
  echo "Network error or empty response | color=red"
  echo "Open usage page | href=https://claude.ai/settings/usage"
  exit 0
fi

# Parse with python3 (ships with macOS CLT). Outputs SwiftBar-formatted lines.
python3 - "$RESPONSE" <<'PY'
import json, sys, datetime, re

raw = sys.argv[1]
try:
    d = json.loads(raw)
except Exception:
    # If body isn't JSON, it's almost certainly an auth/Cloudflare error page.
    print("⚠️ Claude auth")
    print("---")
    snippet = re.sub(r"\s+", " ", raw)[:120]
    print(f"Response not JSON: {snippet} | color=red")
    print("Re-login at claude.ai, then update Keychain sessionKey | href=https://claude.ai/settings/usage")
    sys.exit(0)

def pct(node):
    if not isinstance(node, dict): return None
    return node.get("utilization")

def resets(node):
    if not isinstance(node, dict): return None
    return node.get("resets_at")

def fmt_delta(iso):
    if not iso: return ""
    try:
        # Python 3.11+ handles offset fine; strip fractional if needed
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return iso
    now = datetime.datetime.now(datetime.timezone.utc)
    delta = t - now
    secs = int(delta.total_seconds())
    if secs <= 0: return "resetting…"
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    mins, _ = divmod(rem, 60)
    if days:  return f"{days}d {hours}h"
    if hours: return f"{hours}h {mins}m"
    return f"{mins}m"

def fmt_local(iso):
    if not iso: return ""
    try:
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
        return t.strftime("%a %H:%M")
    except Exception:
        return iso

fh = d.get("five_hour") or {}
sd = d.get("seven_day") or {}
eu = d.get("extra_usage") or {}

sess_pct = pct(fh)
week_pct = pct(sd)

# Menu-bar title
parts = []
if sess_pct is not None: parts.append(f"⚡{sess_pct}%")
if week_pct is not None: parts.append(f"📅{week_pct}%")
if not parts: parts.append("Claude")
title_color = ""
hottest = max([p for p in [sess_pct, week_pct] if p is not None] or [0])
if hottest >= 90:   title_color = " | color=red"
elif hottest >= 75: title_color = " | color=orange"
print(" · ".join(parts) + title_color)

print("---")
print(f"Claude usage | href=https://claude.ai/settings/usage")
print("---")

if sess_pct is not None:
    print(f"Current session: {sess_pct}% used")
    rt = resets(fh)
    if rt:
        print(f"-- resets in {fmt_delta(rt)}  ({fmt_local(rt)})")

if week_pct is not None:
    print(f"Weekly (all models): {week_pct}% used")
    rt = resets(sd)
    if rt:
        print(f"-- resets in {fmt_delta(rt)}  ({fmt_local(rt)})")

if eu and eu.get("is_enabled"):
    used   = eu.get("used_credits", 0)
    limit  = eu.get("monthly_limit", 0)
    pctv   = eu.get("utilization", 0)
    cur    = eu.get("currency", "")
    color  = " color=red" if pctv >= 100 else (" color=orange" if pctv >= 80 else "")
    print(f"Extra credits: {pctv}% ({used}/{limit} {cur}) |{color}")

print("---")
print("Refresh | refresh=true")
print("Open usage page | href=https://claude.ai/settings/usage")
PY
