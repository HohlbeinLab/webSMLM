#!/usr/bin/env python3
"""webSMLM parameter-sweep benchmark driver — a Python equivalent of
tools/browser-sweep.sh, standard library only (no pip install needed).

Launches a real browser at webSMLM.html's ?autorun=1&download=1&... URL
(docs/DOCUMENTATION.md §8 "URL-param autorun") once per value of one
swept parameter, waits for the 5 result files it downloads, collects them
into a working folder, and prints a timing summary.

Cross-platform browser launching is handled entirely by the stdlib
`webbrowser` module (macOS/Windows/Linux all work without per-OS branching)
— that's the main reason this version is worth having alongside the bash
one; the equivalent bash script has to hand-roll `open`/`cmd.exe start`/
`xdg-open` branches itself. Tab-closing between runs is the one thing
`webbrowser` can't do — same as the bash script, it's AppleScript-only on
macOS and skipped everywhere else (tabs accumulate; harmless, just untidy).

This is deliberately simpler than tools/webSMLM-cli.mjs ("Layer 2" in
docs/REFACTOR_PLAN.md's v0.10.0 plan, step 6 — a real Playwright-driven
browser-automation tool): no npm dependency to install, but no true
headless mode either (see that file's step 5 note on why a bare
--headless flag isn't a safe substitute for a real automation framework
here), no direct read of the page's JS state, and it relies on the
browser's Downloads folder behaving predictably. Reach for
tools/webSMLM-cli.mjs instead once that matters more than "no install
needed" — CI, a single run, true headless operation, or building a 3D
calibration (§7/§8 of docs/DOCUMENTATION.md), none of which this script
or its parameter-sweep sibling can do.

Usage: python3 tools/browser_sweep.py   (edit the CONFIGURE ME block below)
"""
import functools
import http.server
import json
import platform
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

# ============================ configure me =================================
REPO_DIR = Path(__file__).resolve().parent.parent
WORK_DIR = Path.home() / "webSMLM_bench"       # holds input data + collected results
INPUT_TIFF = "GATTA-PAINT-80R-raw_cropped.tif"  # must already exist in WORK_DIR
PORT = 8123

PXNM = 99.2
METHOD = "gaussmle"
EXTRA_PARAMS = {}                              # e.g. {"gain": "1", "camoffset": "0"}

PARAM_NAME = "winr"                            # the ?param= to sweep
PARAM_VALUES = [2, 3, 4, 5, 6, 7, 8]

TIMEOUT_S = 180                                # per-run wait for the download to land
# =============================================================================

RESULT_NAMES = ["result.json", "result.csv", "settings.json", "log.txt", "reconstruction.png"]


def default_downloads_dir() -> Path:
    """Best-effort: the Downloads folder the browser actually writes to.
    Correct as-is for macOS, Linux, and native Windows. WSL is the awkward
    case: its $HOME is a separate filesystem from Windows, and a browser
    launched via Windows interop downloads into the WINDOWS-side Downloads
    folder instead — this tries to ask Windows directly via cmd.exe."""
    home = Path.home()
    if "microsoft" in platform.uname().release.lower():
        try:
            win_profile = subprocess.check_output(
                ["cmd.exe", "/c", "echo %USERPROFILE%"], text=True, timeout=5
            ).strip()
            drive, rest = win_profile.split(":", 1)
            return Path("/mnt") / drive.lower() / rest.strip("\\").replace("\\", "/") / "Downloads"
        except Exception:
            print("  (couldn't ask Windows for its Downloads folder via cmd.exe — "
                  "falling back to $HOME/Downloads, which is probably wrong on WSL)", file=sys.stderr)
    return home / "Downloads"


def close_current_tab():
    """Best-effort, macOS only — see the module docstring."""
    if platform.system() == "Darwin":
        subprocess.run(
            ["osascript", "-e", 'tell application "Google Chrome" to close active tab of front window'],
            capture_output=True,
        )


def serve_work_dir(work_dir: Path, port: int) -> socketserver.TCPServer:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(work_dir))
    socketserver.TCPServer.allow_reuse_address = True   # avoid "Address already in use" on quick re-runs
    httpd = socketserver.TCPServer(("", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    input_path = WORK_DIR / INPUT_TIFF
    if not input_path.exists():
        sys.exit(f"error: {input_path} not found — put your input TIFF there first.")

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    results_dir = WORK_DIR / "results"
    results_dir.mkdir(exist_ok=True)
    shutil.copy(REPO_DIR / "webSMLM.html", WORK_DIR / "webSMLM.html")
    print(f"Copied webSMLM.html into {WORK_DIR}")

    downloads_dir = default_downloads_dir()
    print(f"Downloads folder: {downloads_dir} (platform: {platform.system()})")
    result_json, result_csv, settings_json, log_txt, recon_png = (
        downloads_dir / f"webSMLM_autorun_{n}" for n in RESULT_NAMES
    )

    httpd = serve_work_dir(WORK_DIR, PORT)
    try:
        base_url = f"http://localhost:{PORT}/webSMLM.html"
        file_url = f"http://localhost:{PORT}/{INPUT_TIFF}"
        summary_rows = ["param,wallClockS,nLocalizations,computeMs,detectMs,fitMs"]

        for val in PARAM_VALUES:
            for f in (result_json, result_csv, settings_json, log_txt, recon_png):
                f.unlink(missing_ok=True)

            extra = "".join(f"&{k}={v}" for k, v in EXTRA_PARAMS.items())
            url = (f"{base_url}?autorun=1&download=1&fileUrl={file_url}"
                   f"&pxnm={PXNM}&method={METHOD}&{PARAM_NAME}={val}{extra}")
            print(f"Running {PARAM_NAME}={val} ...")
            t0 = time.time()
            webbrowser.open(url)

            # Poll for the LAST file the page writes, as a proxy for "all 5
            # are done" — they're written sequentially in that order.
            waited = 0
            while not recon_png.exists() and waited < TIMEOUT_S:
                time.sleep(1)
                waited += 1
            t1 = time.time()

            if result_json.exists():
                data = json.loads(result_json.read_text())
                nloc = data["nLocalizations"]
                t = data["timings"]
                compute_ms, detect_ms, fit_ms = round(t["dt"]), round(t["tDetect"]), round(t["tFit"])
                dest = results_dir / f"{PARAM_NAME}_{val}"
                dest.mkdir(exist_ok=True)
                for src, name in zip((result_json, result_csv, settings_json, log_txt, recon_png), RESULT_NAMES):
                    if src.exists():
                        shutil.move(str(src), str(dest / name))
                summary_rows.append(f"{val},{t1 - t0:.0f},{nloc},{compute_ms},{detect_ms},{fit_ms}")
                print(f"  done: {nloc} localizations, {compute_ms} ms compute "
                      f"({detect_ms} detect + {fit_ms} fit), {t1 - t0:.0f}s wall "
                      f"(incl. browser overhead) -> {dest}")
            else:
                print(f"  TIMED OUT after {TIMEOUT_S}s waiting for {recon_png}", file=sys.stderr)
                summary_rows.append(f"{val},TIMEOUT,,,,")

            close_current_tab()

        (results_dir / "sweep_summary.csv").write_text("\n".join(summary_rows) + "\n")
        print("\nDone. Summary:")
        print("\n".join(summary_rows))
        print(f"\nPer-run files in {results_dir}/{PARAM_NAME}_<value>/")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
