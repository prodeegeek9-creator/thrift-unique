#!/usr/bin/env bash
# Links the platform's WhatsApp number to WAHA.
#
# WAHA offers a session about a minute of QR codes, each living ~20s, then
# marks it FAILED if nobody scans. Saving a PNG and opening it somewhere else
# is too slow for that window, so this draws the QR in the terminal and redraws
# it whenever WAHA rotates it, until the phone links or the window closes.
#
# Safe to re-run: creates the session if it is missing, restarts it if it is
# stopped or failed, and exits at once if it is already linked. Run it again
# whenever the platform number gets logged out.
set -euo pipefail
cd "$(dirname "$0")"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${WAHA_API_KEY:?WAHA_API_KEY missing from .env}"
if [ -z "${WAHA_URL:-}" ]; then
  : "${WAHA_DOMAIN:?set WAHA_DOMAIN (or WAHA_URL) in .env}"
fi
BASE="${WAHA_URL:-https://${WAHA_DOMAIN}}"
BASE="${BASE%/}"
SESSION="${WAHA_SESSION:-ut-platform}"

api() {
  curl -sS -H "X-Api-Key: ${WAHA_API_KEY}" -H "Content-Type: application/json" "$@"
}

status() {
  api "${BASE}/api/sessions/${SESSION}" | grep -o '"status":"[A-Z_]*"' | head -1 | cut -d'"' -f4 || true
}

if ! command -v qrencode >/dev/null; then
  echo "Installing qrencode to draw the QR in the terminal..."
  # needrestart would otherwise open an interactive dialog that the silenced
  # output hides, leaving the script waiting on a keypress nobody can see.
  sudo env NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive \
    apt-get install -y -qq qrencode >/dev/null
fi

code=$(api -o /dev/null -w '%{http_code}' "${BASE}/api/sessions/${SESSION}")
if [ "$code" = "404" ]; then
  : "${PUBLIC_ORIGIN:?session ${SESSION} does not exist yet; set PUBLIC_ORIGIN in .env to create it}"
  : "${WAHA_WEBHOOK_SECRET:?session ${SESSION} does not exist yet; set WAHA_WEBHOOK_SECRET in .env to create it}"
  echo "Creating session ${SESSION}..."
  api -o /dev/null "${BASE}/api/sessions" -d "{
    \"name\": \"${SESSION}\",
    \"config\": {
      \"webhooks\": [{
        \"url\": \"${PUBLIC_ORIGIN%/}/api/waha/webhook\",
        \"events\": [\"message\", \"session.status\"],
        \"customHeaders\": [{ \"name\": \"X-Thrift-Secret\", \"value\": \"${WAHA_WEBHOOK_SECRET}\" }]
      }]
    }
  }"
elif [ "$code" != "200" ]; then
  echo "WAHA answered ${code} for ${SESSION}; check WAHA_DOMAIN and WAHA_API_KEY in .env." >&2
  exit 1
fi

case "$(status)" in
  WORKING)
    echo "${SESSION} is already linked."
    exit 0
    ;;
  SCAN_QR_CODE) ;;
  *)
    api -o /dev/null -X POST "${BASE}/api/sessions/${SESSION}/stop" || true
    api -o /dev/null -X POST "${BASE}/api/sessions/${SESSION}/start"
    ;;
esac

echo "Starting ${SESSION}; the QR appears here in a few seconds."
started=$SECONDS
last=""
while [ $((SECONDS - started)) -lt 150 ]; do
  s=$(status)
  case "$s" in
    WORKING)
      echo
      echo "Linked. ${SESSION} is WORKING."
      exit 0
      ;;
    FAILED | STOPPED)
      # Right after a restart the old state can still be reported for a moment.
      if [ $((SECONDS - started)) -gt 15 ]; then
        echo
        echo "WAHA closed the pairing window (${s}). Run ./pair.sh again for a fresh QR." >&2
        exit 1
      fi
      ;;
    SCAN_QR_CODE)
      qr=$(api "${BASE}/api/${SESSION}/auth/qr?format=raw" | sed -n 's/.*"value":"\([^"]*\)".*/\1/p')
      if [ -n "$qr" ] && [ "$qr" != "$last" ]; then
        clear 2>/dev/null || true
        echo "On the phone: WhatsApp > Settings > Linked devices > Link a device"
        qrencode -t ANSIUTF8 -m 2 "$qr"
        echo "Waiting for the scan (this QR refreshes on its own)..."
        last=$qr
      fi
      ;;
  esac
  sleep 2
done

echo "Timed out waiting for the scan. Run ./pair.sh again for a fresh QR." >&2
exit 1
