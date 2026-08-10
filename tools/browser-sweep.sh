#!/usr/bin/env bash
# webSMLM parameter-sweep benchmark driver (macOS).
#
# Launches a REAL browser against webSMLM.html's ?autorun=1 URL-param API
# (docs/DOCUMENTATION.md \S8 "URL-param autorun") once per value of one
# parameter, waits for the result files it downloads (&download=1), moves
# them into a results folder, and prints a timing table. No browser-
# automation framework (Playwright/Selenium/etc.) needed — this drives
# Layer 0 (autorun) from the outside via plain filesystem polling.
#
# This is deliberately simpler than the Playwright-based "Layer 2" CLI
# sketched in docs/REFACTOR_PLAN.md's v0.10.0 plan (step 6, not built yet):
# no dependency to install, but also no true headless mode, no direct read
# of the page's JS state, and it relies on the browser's Downloads folder
# behaving predictably. Reach for Layer 2 instead once/if that matters
# (e.g. CI, or many parallel runs).
#
# ---- how it works ----
# 1. WORK_DIR holds your input TIFF(s); this script copies the current
#    webSMLM.html into it and serves WORK_DIR over local HTTP, so both the
#    app and the data are reachable as plain fetchable URLs.
# 2. For each sweep value: clear any stale result files from Downloads,
#    open the browser at a ?autorun=1&download=1&... URL with that value,
#    poll Downloads for webSMLM_autorun_result.{json,csv} to appear, then
#    move them into WORK_DIR/results/<PARAM_NAME>_<value>/.
# 3. Prints a CSV summary (param value, wall clock, localization count,
#    compute ms) to stdout and to WORK_DIR/results/sweep_summary.csv.
set -euo pipefail

# ============================ configure me ================================
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this repo's root
WORK_DIR="$HOME/webSMLM_bench"                # holds input data + collected results
INPUT_TIFF="GATTA-PAINT-80R-raw_cropped.tif"  # must already exist in WORK_DIR
PORT=8123
BROWSER="Google Chrome"                       # or "Firefox", "Safari"
DOWNLOADS_DIR="$HOME/Downloads"               # where the browser actually saves downloads

PXNM=99.2
METHOD=gaussmle
EXTRA_PARAMS=""                               # e.g. "&gain=1&camoffset=0"

PARAM_NAME=winr                               # the ?param= to sweep
PARAM_VALUES=(2 3 4 5 6 7 8)

TIMEOUT_S=180                                 # per-run wait for the download to land
# ============================================================================

RESULTS_DIR="$WORK_DIR/results"
JSON_FILE="$DOWNLOADS_DIR/webSMLM_autorun_result.json"
CSV_FILE="$DOWNLOADS_DIR/webSMLM_autorun_result.csv"
SUMMARY_CSV="$RESULTS_DIR/sweep_summary.csv"

if [ ! -f "$WORK_DIR/$INPUT_TIFF" ]; then
  echo "error: $WORK_DIR/$INPUT_TIFF not found — put your input TIFF there first." >&2
  exit 1
fi

mkdir -p "$RESULTS_DIR"
cp "$REPO_DIR/webSMLM.html" "$WORK_DIR/webSMLM.html"
echo "Copied webSMLM.html into $WORK_DIR"

# Serve WORK_DIR in the background; stop it on exit however this script ends.
( cd "$WORK_DIR" && python3 -m http.server "$PORT" >/tmp/webSMLM_sweep_http.log 2>&1 ) &
HTTP_PID=$!
trap 'kill "$HTTP_PID" 2>/dev/null || true' EXIT
sleep 1   # give the server a moment to bind

BASE_URL="http://localhost:$PORT/webSMLM.html"
FILE_URL="http://localhost:$PORT/$INPUT_TIFF"

echo "param,wallClockS,nLocalizations,computeMs,detectMs,fitMs" > "$SUMMARY_CSV"

for val in "${PARAM_VALUES[@]}"; do
  rm -f "$JSON_FILE" "$CSV_FILE"
  url="${BASE_URL}?autorun=1&download=1&fileUrl=${FILE_URL}&pxnm=${PXNM}&method=${METHOD}&${PARAM_NAME}=${val}${EXTRA_PARAMS}"
  echo "Running ${PARAM_NAME}=${val} ..."
  t0=$(date +%s)
  open -a "$BROWSER" "$url"

  waited=0
  until [ -f "$JSON_FILE" ]; do
    sleep 1; waited=$((waited+1))
    if [ "$waited" -ge "$TIMEOUT_S" ]; then
      echo "  TIMED OUT after ${TIMEOUT_S}s waiting for $JSON_FILE" >&2
      break
    fi
  done
  t1=$(date +%s)

  if [ -f "$JSON_FILE" ]; then
    read -r nloc computeMs detectMs fitMs < <(python3 -c "
import json
d = json.load(open('$JSON_FILE'))
t = d['timings']
print(d['nLocalizations'], round(t['dt']), round(t['tDetect']), round(t['tFit']))
")
    dest="$RESULTS_DIR/${PARAM_NAME}_${val}"
    mkdir -p "$dest"
    mv "$JSON_FILE" "$dest/result.json"
    [ -f "$CSV_FILE" ] && mv "$CSV_FILE" "$dest/locs.csv"
    echo "${val},$((t1-t0)),${nloc},${computeMs},${detectMs},${fitMs}" >> "$SUMMARY_CSV"
    echo "  done: ${nloc} localizations, ${computeMs} ms compute (${detectMs} detect + ${fitMs} fit), $((t1-t0))s wall (incl. browser overhead) -> $dest"
  else
    echo "${val},TIMEOUT,,,," >> "$SUMMARY_CSV"
  fi

  # Best-effort: close the tab so they don't pile up. macOS/browser-specific;
  # harmless if it fails (e.g. Safari's AppleScript dictionary differs).
  osascript -e "tell application \"$BROWSER\" to close active tab of front window" 2>/dev/null || true
done

echo
echo "Done. Summary:"
column -s, -t "$SUMMARY_CSV"
echo
echo "Per-run JSON/CSV in $RESULTS_DIR/${PARAM_NAME}_<value>/"
