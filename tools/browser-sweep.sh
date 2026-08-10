#!/usr/bin/env bash
# webSMLM parameter-sweep benchmark driver.
#
# Launches a REAL browser against webSMLM.html's ?autorun=1 URL-param API
# (docs/DOCUMENTATION.md \S8 "URL-param autorun") once per value of one
# parameter, waits for the result files it downloads (&download=1), moves
# them into a results folder, and prints a timing table. No browser-
# automation framework (Playwright/Selenium/etc.) needed — this drives
# Layer 0 (autorun) from the outside via plain filesystem polling.
#
# This is deliberately simpler than tools/webSMLM-cli.mjs ("Layer 2" in
# docs/REFACTOR_PLAN.md's v0.10.0 plan, step 6 -- a real Playwright-driven
# browser-automation tool): no npm dependency to install, but also no true
# headless mode (see that file's step 5 note on why a bare --headless flag
# isn't a safe substitute here), no direct read of the page's JS state, and
# it relies on the browser's Downloads folder behaving predictably. Reach
# for tools/webSMLM-cli.mjs instead once that matters more than "no install
# needed" -- CI, a single run, true headless operation, or building a 3D
# calibration (\S7/\S8 of docs/DOCUMENTATION.md), none of which this script
# or its parameter-sweep sibling can do.
#
# A tools/browser_sweep.py equivalent also exists, and is probably the
# easier one to read/adapt — Python's stdlib `webbrowser` module already
# abstracts the per-OS launch command this script has to hand-roll below.
#
# ---- platform support ----
# macOS: full support, including auto-closing each tab between runs.
# Linux / native Windows (Git Bash) / WSL: browser launch and Downloads-
# folder detection are best-effort (untested outside macOS — please report
# back what does/doesn't work). Tab-closing has NO equivalent outside macOS
# (no AppleScript, nothing built-in on Windows or Linux) and is skipped —
# tabs will simply accumulate; close them yourself between runs if that
# matters, or just let them pile up and close them all at the end.
#
# ---- how it works ----
# 1. WORK_DIR holds your input TIFF(s); this script copies the current
#    webSMLM.html into it and serves WORK_DIR over local HTTP, so both the
#    app and the data are reachable as plain fetchable URLs.
# 2. For each sweep value: clear any stale result files from Downloads,
#    open the browser at a ?autorun=1&download=1&... URL with that value,
#    poll Downloads for the 5 result files to appear, then move them into
#    WORK_DIR/results/<PARAM_NAME>_<value>/.
# 3. Prints a CSV summary (param value, wall clock, localization count,
#    compute ms) to stdout and to WORK_DIR/results/sweep_summary.csv.
set -euo pipefail

# ---- platform detection ----
case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
  Linux) if grep -qi microsoft /proc/version 2>/dev/null; then PLATFORM=wsl; else PLATFORM=linux; fi ;;
  *) PLATFORM=unknown ;;
esac

# ============================ configure me ================================
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this repo's root
WORK_DIR="$HOME/webSMLM_bench"                # holds input data + collected results
INPUT_TIFF="GATTA-PAINT-80R-raw_cropped.tif"  # must already exist in WORK_DIR
PORT=8123

# Browser: a macOS app name, OR an executable name elsewhere (must be on
# PATH for Linux xdg-open/direct-launch, or resolvable by Windows' `start`).
BROWSER_MACOS="Google Chrome"
BROWSER_OTHER="chrome"                        # e.g. "chrome", "msedge", "firefox"

# Downloads folder the browser actually writes to. $HOME/Downloads is
# correct for macOS, Linux, and native Windows via Git Bash (whose $HOME
# already maps into the Windows user profile). WSL is the awkward case: its
# $HOME (/home/<user>) is a SEPARATE filesystem from Windows, and a browser
# launched via Windows interop (cmd.exe) downloads into the WINDOWS-side
# Downloads folder instead — override this if you're on WSL and it's wrong.
DOWNLOADS_DIR="$HOME/Downloads"
if [ "$PLATFORM" = wsl ] && [ -d "/mnt/c/Users/$USER/Downloads" ]; then
  DOWNLOADS_DIR="/mnt/c/Users/$USER/Downloads"   # best guess; check your actual Windows username matches $USER
fi

PXNM=99.2
METHOD=gaussmle
EXTRA_PARAMS=""                               # e.g. "&gain=1&camoffset=0"

PARAM_NAME=winr                               # the ?param= to sweep
PARAM_VALUES=(2 3 4 5 6 7 8)

TIMEOUT_S=180                                 # per-run wait for the download to land
# ============================================================================

RESULTS_DIR="$WORK_DIR/results"
RESULT_JSON="$DOWNLOADS_DIR/webSMLM_autorun_result.json"
RESULT_CSV="$DOWNLOADS_DIR/webSMLM_autorun_result.csv"
SETTINGS_JSON="$DOWNLOADS_DIR/webSMLM_autorun_settings.json"
LOG_TXT="$DOWNLOADS_DIR/webSMLM_autorun_log.txt"
RECON_PNG="$DOWNLOADS_DIR/webSMLM_autorun_reconstruction.png"   # written LAST by the page — see below

if [ ! -f "$WORK_DIR/$INPUT_TIFF" ]; then
  echo "error: $WORK_DIR/$INPUT_TIFF not found — put your input TIFF there first." >&2
  exit 1
fi
if [ "$PLATFORM" = unknown ]; then
  echo "warning: unrecognised platform ($(uname -s)) — browser launch below will likely fail; edit launch_browser() in this script." >&2
fi

mkdir -p "$RESULTS_DIR"
cp "$REPO_DIR/webSMLM.html" "$WORK_DIR/webSMLM.html"
echo "Copied webSMLM.html into $WORK_DIR (platform: $PLATFORM)"

# Serve WORK_DIR in the background; stop it on exit however this script ends.
( cd "$WORK_DIR" && python3 -m http.server "$PORT" >/tmp/webSMLM_sweep_http.log 2>&1 ) &
HTTP_PID=$!
trap 'kill "$HTTP_PID" 2>/dev/null || true' EXIT
sleep 1   # give the server a moment to bind

BASE_URL="http://localhost:$PORT/webSMLM.html"
FILE_URL="http://localhost:$PORT/$INPUT_TIFF"

launch_browser(){
  local url="$1"
  case "$PLATFORM" in
    macos) open -a "$BROWSER_MACOS" "$url" ;;
    windows) cmd.exe /c start "" "$BROWSER_OTHER" "$url" 2>/dev/null || cmd.exe /c start "" "$url" ;;
    wsl)     cmd.exe /c start "" "$BROWSER_OTHER" "$url" 2>/dev/null || cmd.exe /c start "" "$url" ;;
    linux)   xdg-open "$url" >/dev/null 2>&1 & disown || "$BROWSER_OTHER" "$url" >/dev/null 2>&1 & disown ;;
    *)       echo "  (can't launch a browser automatically — open manually: $url)" >&2 ;;
  esac
}
close_current_tab(){
  # No cross-platform equivalent — only macOS has a built-in way to script
  # an already-running GUI app. Elsewhere this is a silent no-op; tabs
  # accumulate, which is harmless, just untidy.
  if [ "$PLATFORM" = macos ]; then
    osascript -e "tell application \"$BROWSER_MACOS\" to close active tab of front window" 2>/dev/null || true
  fi
}

echo "param,wallClockS,nLocalizations,computeMs,detectMs,fitMs" > "$RESULTS_DIR/sweep_summary.csv"

for val in "${PARAM_VALUES[@]}"; do
  rm -f "$RESULT_JSON" "$RESULT_CSV" "$SETTINGS_JSON" "$LOG_TXT" "$RECON_PNG"
  url="${BASE_URL}?autorun=1&download=1&fileUrl=${FILE_URL}&pxnm=${PXNM}&method=${METHOD}&${PARAM_NAME}=${val}${EXTRA_PARAMS}"
  echo "Running ${PARAM_NAME}=${val} ..."
  t0=$(date +%s)
  launch_browser "$url"

  # Poll for the LAST file the page writes (reconstruction.png) — a proxy
  # for "all 5 are done", since they're written sequentially in that order.
  waited=0
  until [ -f "$RECON_PNG" ]; do
    sleep 1; waited=$((waited+1))
    if [ "$waited" -ge "$TIMEOUT_S" ]; then
      echo "  TIMED OUT after ${TIMEOUT_S}s waiting for $RECON_PNG" >&2
      break
    fi
  done
  t1=$(date +%s)

  if [ -f "$RESULT_JSON" ]; then
    read -r nloc computeMs detectMs fitMs < <(python3 -c "
import json
d = json.load(open('$RESULT_JSON'))
t = d['timings']
print(d['nLocalizations'], round(t['dt']), round(t['tDetect']), round(t['tFit']))
")
    dest="$RESULTS_DIR/${PARAM_NAME}_${val}"
    mkdir -p "$dest"
    mv "$RESULT_JSON" "$dest/result.json"
    [ -f "$RESULT_CSV" ] && mv "$RESULT_CSV" "$dest/locs.csv"
    [ -f "$SETTINGS_JSON" ] && mv "$SETTINGS_JSON" "$dest/settings.json"
    [ -f "$LOG_TXT" ] && mv "$LOG_TXT" "$dest/log.txt"
    [ -f "$RECON_PNG" ] && mv "$RECON_PNG" "$dest/reconstruction.png"
    echo "${val},$((t1-t0)),${nloc},${computeMs},${detectMs},${fitMs}" >> "$RESULTS_DIR/sweep_summary.csv"
    echo "  done: ${nloc} localizations, ${computeMs} ms compute (${detectMs} detect + ${fitMs} fit), $((t1-t0))s wall (incl. browser overhead) -> $dest"
  else
    echo "${val},TIMEOUT,,,," >> "$RESULTS_DIR/sweep_summary.csv"
  fi

  close_current_tab
done

echo
echo "Done. Summary:"
if command -v column >/dev/null 2>&1; then
  column -s, -t "$RESULTS_DIR/sweep_summary.csv"
else
  cat "$RESULTS_DIR/sweep_summary.csv"
fi
echo
echo "Per-run files in $RESULTS_DIR/${PARAM_NAME}_<value>/"
